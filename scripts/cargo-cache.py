"""Repair missing Cargo cache entries over HTTPS when Cargo's transport times out.
Uses the official crates.io index and verifies archives against index checksums.
Does not alter Cargo configuration, credentials, or TLS verification.
"""
from pathlib import Path
import concurrent.futures, hashlib, json, re, subprocess, tempfile, tomllib

workspace=Path(__file__).resolve().parents[1]
cargo=Path.home()/'.cargo'
index=cargo/'registry/index/index.crates.io-1949cf8c6b5b557f'
cache=cargo/'registry/cache/index.crates.io-1949cf8c6b5b557f'
def download(url):
    with tempfile.NamedTemporaryFile(delete=False) as f: temp=Path(f.name)
    try:
        subprocess.run(['curl.exe','--fail','--silent','--show-error','--retry','3','--max-time','90',url,'-o',str(temp)],check=True)
        return temp.read_bytes()
    finally: temp.unlink(missing_ok=True)
def index_entry(name):
    path=name if len(name)==1 else '2/'+name if len(name)==2 else '3/'+name[0]+'/'+name if len(name)==3 else name[:2]+'/'+name[2:4]+'/'+name
    data=download('https://index.crates.io/'+path)
    out=b'\x03\x02\x00\x00\x00etag: "local-https-fetch"\x00'
    for line in data.splitlines():
        obj=json.loads(line);out+=obj['vers'].encode()+b'\x00'+line+b'\x00'
    dest=index/'.cache'/path;dest.parent.mkdir(parents=True,exist_ok=True);dest.write_bytes(out)
    print('Index:',name,flush=True)
for _ in range(160):
    result=subprocess.run(['cargo','generate-lockfile','--offline','--manifest-path','src-tauri/Cargo.toml'],cwd=workspace,capture_output=True,text=True,encoding='utf-8')
    if result.returncode==0:break
    missing=re.search(r"no matching package named `([^`]+)`",result.stderr)
    if not missing:
        print(result.stderr,flush=True);raise SystemExit(1)
    index_entry(missing[1])
else:raise SystemExit('Too many missing index entries')
lock=tomllib.loads((workspace/'src-tauri/Cargo.lock').read_text())
cache.mkdir(parents=True,exist_ok=True)
def archive(p):
    if not p.get('source','').startswith('registry+'):return
    dest=cache/f"{p['name']}-{p['version']}.crate"
    if dest.exists() and hashlib.sha256(dest.read_bytes()).hexdigest()==p['checksum']:return
    data=download(f"https://static.crates.io/crates/{p['name']}/{p['name']}-{p['version']}.crate")
    if hashlib.sha256(data).hexdigest()!=p['checksum']:raise RuntimeError('Checksum mismatch: '+p['name'])
    dest.write_bytes(data);print('Verified:',p['name'],p['version'],flush=True)
with concurrent.futures.ThreadPoolExecutor(max_workers=6) as pool:list(pool.map(archive,lock['package']))
print('Cargo cache ready.',flush=True)
