"""Fetch only the native Perl runtime from the vendor's official portable ZIP.
HTTPS range requests; ZIP CRC checked by zipfile for every extracted member.
Build tooling only; nothing is added to the system PATH or installed globally.
"""
from pathlib import Path
import concurrent.futures,io,subprocess,zipfile
base=Path(__file__).resolve().parents[1]/'.tools'
base.mkdir(exist_ok=True)
url='https://strawberryperl.com/download/5.32.1.1/strawberry-perl-5.32.1.1-64bit-portable.zip'
length=158865967
chunk=128*1024
def fetch(i):
    start=i*chunk;end=min(start+chunk,length)-1;dest=base/f'perl32-range-{i}'
    if dest.exists() and dest.stat().st_size==end-start+1:return dest.read_bytes()
    subprocess.run(['curl.exe','-fsSL','--retry','3','--max-time','45','--range',f'{start}-{end}',url,'-o',str(dest)],check=True)
    if dest.stat().st_size!=end-start+1:raise RuntimeError('Invalid range response')
    return dest.read_bytes()
class Remote(io.RawIOBase):
    def __init__(self):self.pos=0
    def seekable(self):return True
    def readable(self):return True
    def tell(self):return self.pos
    def seek(self,n,whence=0):self.pos=n if whence==0 else self.pos+n if whence==1 else length+n;return self.pos
    def read(self,n=-1):
        if n<0:n=length-self.pos
        n=min(n,length-self.pos)
        if n<=0:return b''
        indices=list(range(self.pos//chunk,(self.pos+n-1)//chunk+1))
        with concurrent.futures.ThreadPoolExecutor(max_workers=12) as pool:buf=b''.join(pool.map(fetch,indices))
        out=buf[self.pos%chunk:self.pos%chunk+n];self.pos+=n;return out
with zipfile.ZipFile(Remote()) as z:
    files=[f for f in z.infolist() if (f.filename.startswith('perl/bin/') and f.filename.endswith(('.exe','.dll'))) or (f.filename.startswith('perl/lib/') and '/CORE/' not in f.filename and f.filename.endswith(('.pm','.pl','.dll','.al','.ix')))]
    print('Runtime:',len(files),'files;',sum(f.compress_size for f in files),'compressed bytes',flush=True)
    chunks=set()
    for f in files:chunks.update(range(f.header_offset//chunk,(f.header_offset+f.compress_size+len(f.filename.encode())+1024)//chunk+1))
    print('Fetching',len(chunks),'ranges',flush=True)
    def get(i):fetch(i);print('Range',i,flush=True)
    with concurrent.futures.ThreadPoolExecutor(max_workers=12) as pool:list(pool.map(get,sorted(chunks)))
    for f in files:z.extract(f,base/'native-perl')
print('Native Perl runtime extracted with CRC validation.',flush=True)
