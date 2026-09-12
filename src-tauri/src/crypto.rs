use base64::{engine::general_purpose::STANDARD as B64, Engine};
use serde::{Deserialize, Serialize};
use sodiumoxide::crypto::{
    kdf, pwhash::argon2id13 as pw, secretbox, secretstream::xchacha20poly1305 as stream,
};
use std::io::{Read, Write};
use zeroize::Zeroize;

pub type Result<T> = std::result::Result<T, String>;
pub const AUTH_ERROR: &str = "Неверный пароль или ключ. Возможно, хранилище повреждено.";
pub fn init() -> Result<()> {
    #[cfg(windows)]
    {
        static WORKING_SET: std::sync::Once = std::sync::Once::new();
        WORKING_SET.call_once(|| unsafe {
            // SQLCipher locks its allocations best-effort. The Windows default
            // minimum working set is too small even for a modest encrypted index.
            use windows_sys::Win32::System::Threading::{
                GetCurrentProcess, SetProcessWorkingSetSize,
            };
            SetProcessWorkingSetSize(GetCurrentProcess(), 64 * 1024 * 1024, 512 * 1024 * 1024);
        });
    }
    sodiumoxide::init().map_err(|_| "Не удалось запустить криптографию".into())
}
pub fn hex(bytes: &[u8]) -> String {
    bytes.iter().map(|b| format!("{b:02x}")).collect()
}
fn unhex(s: &str) -> Result<Vec<u8>> {
    let s: String = s
        .chars()
        .filter(|c| !c.is_whitespace() && *c != '-')
        .collect();
    if s.len() != 64 || !s.is_ascii() {
        return Err(AUTH_ERROR.into());
    }
    (0..64)
        .step_by(2)
        .map(|i| u8::from_str_radix(&s[i..i + 2], 16).map_err(|_| AUTH_ERROR.into()))
        .collect()
}
#[derive(Clone, Serialize, Deserialize)]
pub struct Manifest {
    pub version: u32,
    salt: String,
    nonce: String,
    wrapped: String,
    recovery_nonce: String,
    recovery_wrapped: String,
}
pub struct Master(pub secretbox::Key);
impl Master {
    pub fn database_hex(&self) -> String {
        let mut b = [0; 32];
        kdf::derive_from_key(
            &mut b,
            1,
            *b"not.key1",
            &kdf::Key::from_slice(&self.0[..]).unwrap(),
        )
        .unwrap();
        let s = hex(&b);
        b.zeroize();
        s
    }
    pub fn file_key(&self) -> stream::Key {
        let mut b = [0; 32];
        kdf::derive_from_key(
            &mut b,
            2,
            *b"not.key1",
            &kdf::Key::from_slice(&self.0[..]).unwrap(),
        )
        .unwrap();
        let k = stream::Key::from_slice(&b).unwrap();
        b.zeroize();
        k
    }
}
fn password_key(password: &str, salt: &pw::Salt) -> Result<secretbox::Key> {
    let mut key = secretbox::Key([0; 32]);
    pw::derive_key(
        &mut key.0,
        password.as_bytes(),
        salt,
        pw::OPSLIMIT_INTERACTIVE,
        pw::MEMLIMIT_INTERACTIVE,
    )
    .map_err(|_| "Недостаточно памяти для разблокировки")?;
    Ok(key)
}
pub fn create(password: &str) -> Result<(Manifest, Master, String)> {
    if password.chars().count() < 10 {
        return Err("Используйте пароль не короче 10 символов".into());
    }
    let master = Master(secretbox::gen_key());
    let recovery = secretbox::gen_key();
    let salt = pw::gen_salt();
    let nonce = secretbox::gen_nonce();
    let rn = secretbox::gen_nonce();
    let pk = password_key(password, &salt)?;
    let m = Manifest {
        version: 1,
        salt: B64.encode(salt),
        nonce: B64.encode(nonce),
        wrapped: B64.encode(secretbox::seal(&master.0[..], &nonce, &pk)),
        recovery_nonce: B64.encode(rn),
        recovery_wrapped: B64.encode(secretbox::seal(&master.0[..], &rn, &recovery)),
    };
    let raw = hex(&recovery[..]);
    let printable = raw
        .as_bytes()
        .chunks(8)
        .map(|c| std::str::from_utf8(c).unwrap())
        .collect::<Vec<_>>()
        .join("-");
    Ok((m, master, printable))
}
pub fn unlock(m: &Manifest, credential: &str, recovery: bool) -> Result<Master> {
    if m.version != 1 {
        return Err("Версия хранилища не поддерживается".into());
    }
    let decode = |s: &str| B64.decode(s).map_err(|_| AUTH_ERROR.to_string());
    let (key, n, w) = if recovery {
        let mut raw = unhex(credential)?;
        let k = secretbox::Key::from_slice(&raw).ok_or(AUTH_ERROR)?;
        raw.zeroize();
        (k, &m.recovery_nonce, &m.recovery_wrapped)
    } else {
        let salt = pw::Salt::from_slice(&decode(&m.salt)?).ok_or(AUTH_ERROR)?;
        (password_key(credential, &salt)?, &m.nonce, &m.wrapped)
    };
    let nonce = secretbox::Nonce::from_slice(&decode(n)?).ok_or(AUTH_ERROR)?;
    let mut raw = secretbox::open(&decode(w)?, &nonce, &key).map_err(|_| AUTH_ERROR)?;
    let master = Master(secretbox::Key::from_slice(&raw).ok_or(AUTH_ERROR)?);
    raw.zeroize();
    Ok(master)
}
pub fn change_password(m: &mut Manifest, master: &Master, password: &str) -> Result<()> {
    if password.chars().count() < 10 {
        return Err("Используйте пароль не короче 10 символов".into());
    }
    let salt = pw::gen_salt();
    let nonce = secretbox::gen_nonce();
    let key = password_key(password, &salt)?;
    m.salt = B64.encode(salt);
    m.nonce = B64.encode(nonce);
    m.wrapped = B64.encode(secretbox::seal(&master.0[..], &nonce, &key));
    Ok(())
}
const CHUNK: usize = 64 * 1024;
pub fn encrypt_file(mut input: impl Read, mut output: impl Write, master: &Master) -> Result<()> {
    let (mut state, header) =
        stream::Stream::init_push(&master.file_key()).map_err(|_| "Ошибка шифрования")?;
    output
        .write_all(&header[..])
        .map_err(|_| "Ошибка записи вложения")?;
    let mut buf = vec![0; CHUNK];
    let mut total = 0;
    loop {
        let n = input.read(&mut buf).map_err(|_| "Ошибка чтения вложения")?;
        total += n;
        if total > 25 * 1024 * 1024 {
            buf.zeroize();
            return Err("Вложение превышает 25 МБ".into());
        }
        let tag = if n == 0 {
            stream::Tag::Final
        } else {
            stream::Tag::Message
        };
        let cipher = state
            .push(&buf[..n], None, tag)
            .map_err(|_| "Ошибка шифрования")?;
        output
            .write_all(&(cipher.len() as u32).to_le_bytes())
            .and_then(|_| output.write_all(&cipher))
            .map_err(|_| "Ошибка записи вложения")?;
        // Zeroize<Vec> clears its length; the next read would then see an empty
        // buffer and silently finalize after the first chunk. Wipe the slice.
        buf.as_mut_slice().zeroize();
        if n == 0 {
            break;
        }
    }
    Ok(())
}
pub fn decrypt_file(mut input: impl Read, mut output: impl Write, master: &Master) -> Result<u64> {
    let mut h = [0; stream::HEADERBYTES];
    input.read_exact(&mut h).map_err(|_| AUTH_ERROR)?;
    let mut state = stream::Stream::init_pull(&stream::Header(h), &master.file_key())
        .map_err(|_| AUTH_ERROR)?;
    let mut total = 0usize;
    loop {
        let mut len = [0; 4];
        input.read_exact(&mut len).map_err(|_| AUTH_ERROR)?;
        let n = u32::from_le_bytes(len) as usize;
        if !(stream::ABYTES..=CHUNK + stream::ABYTES).contains(&n) {
            return Err(AUTH_ERROR.into());
        }
        let mut cipher = vec![0; n];
        input.read_exact(&mut cipher).map_err(|_| AUTH_ERROR)?;
        let (mut plain, tag) = state.pull(&cipher, None).map_err(|_| AUTH_ERROR)?;
        total += plain.len();
        if total > 25 * 1024 * 1024 {
            return Err("Вложение превышает 25 МБ".into());
        }
        output
            .write_all(&plain)
            .map_err(|_| "Ошибка записи файла")?;
        plain.zeroize();
        if tag == stream::Tag::Final {
            let mut extra = [0; 1];
            if input.read(&mut extra).map_err(|_| AUTH_ERROR)? != 0 {
                return Err(AUTH_ERROR.into());
            }
            break;
        }
    }
    Ok(total as u64)
}

#[cfg(test)]
mod tests {
    use super::*;
    #[test]
    fn attachments_preserve_all_chunks() {
        init().unwrap();
        let master = Master(secretbox::gen_key());
        for size in [
            0,
            CHUNK - 1,
            CHUNK,
            CHUNK + 1,
            CHUNK * 4 + 123,
            25 * 1024 * 1024,
        ] {
            let source: Vec<u8> = (0..size).map(|i| (i % 251) as u8).collect();
            let mut encrypted = Vec::new();
            encrypt_file(source.as_slice(), &mut encrypted, &master).unwrap();
            let mut restored = Vec::new();
            decrypt_file(encrypted.as_slice(), &mut restored, &master).unwrap();
            assert_eq!(restored.len(), source.len(), "attachment length {size}");
            assert!(restored == source, "attachment bytes {size}");
        }
    }
    #[test]
    fn attachments_reject_more_than_twenty_five_mb() {
        init().unwrap();
        let master = Master(secretbox::gen_key());
        assert!(encrypt_file(
            std::io::repeat(42).take(25 * 1024 * 1024 + 1),
            std::io::sink(),
            &master
        )
        .is_err());
    }
}
