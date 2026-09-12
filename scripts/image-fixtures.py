"""Create synthetic image fixtures large enough to span encrypted chunks."""
from pathlib import Path
import random
from PIL import Image, ImageDraw

root = Path(__file__).resolve().parent.parent / "artifacts" / "image-fixtures"
root.mkdir(parents=True, exist_ok=True)
rng = random.Random(2026)
image = Image.frombytes("RGB", (900, 600), rng.randbytes(900 * 600 * 3))
draw = ImageDraw.Draw(image)
draw.rectangle((0, 0, 899, 70), fill=(180, 167, 221))
draw.rectangle((0, 529, 899, 599), fill=(48, 200, 120))
draw.text((20, 25), "TOP - complete image fixture", fill=(20, 20, 25))
draw.text((20, 554), "BOTTOM - must remain visible", fill=(20, 20, 25))
for ext in ("png", "jpg", "webp", "gif"):
    path = root / f"complete.{ext}"
    image.save(path)
    assert path.stat().st_size > 65536
    print(f"{path.name}: {path.stat().st_size} bytes")
