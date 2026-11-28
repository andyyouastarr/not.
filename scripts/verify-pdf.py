"""Validate generated test PDFs and render representative pages (PyMuPDF)."""
import re
import sys
from pathlib import Path

import pymupdf


def verify(path: Path) -> None:
    with pymupdf.open(path) as document:
        text = " ".join(" ".join(page.get_text().split()) for page in document)
        if "Контрольный абзац" in text:
            found = re.findall(r"Контрольный абзац (\d+)\.", text)
            assert sorted(map(int, found)) == list(range(40)), found
            assert "Конец контрольного документа." in text
            assert sum(len(page.get_image_info()) for page in document) == 1
        if "Нативный контроль" in text:
            found = re.findall(r"Нативный контроль (\d+)\.", text)
            assert sorted(map(int, found)) == list(range(25)), found
            assert sum(len(page.get_image_info()) for page in document) == 1
        for page in document:
            assert abs(page.rect.width - 595.276) < 2
            assert abs(page.rect.height - 841.89) < 2
            assert page.get_text().strip(), "Unexpected blank page"
            for image in page.get_image_info():
                bounds = pymupdf.Rect(image["bbox"])
                assert page.rect.contains(bounds), "Image clipped by page"
        for index in {0, len(document) - 1}:
            pixmap = document[index].get_pixmap()
            assert pixmap.pixel(0, 0) == (255, 255, 255), "Dark paper margins"
            pixmap.save(path.with_name(f"{path.stem}-page-{index + 1}.png"))
        print(f"{path}: {len(document)} A4 pages verified")


if __name__ == "__main__":
    for argument in sys.argv[1:]:
        verify(Path(argument))
