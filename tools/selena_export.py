#!/usr/bin/env python3
"""Offline Selena export renderer: canonical CSV -> XLSX + PDF.

This tool is deliberately provider-blind. It only consumes an already-created
canonical ledger and never reads credentials or contacts measurement services.
"""
import argparse
import csv
from copy import copy
from pathlib import Path

from openpyxl import Workbook
from reportlab.lib import colors
from reportlab.lib.pagesizes import A4, landscape
from reportlab.lib.styles import getSampleStyleSheet
from reportlab.lib.units import mm
from reportlab.platypus import Paragraph, SimpleDocTemplate, Spacer, Table, TableStyle


def main() -> None:
    parser = argparse.ArgumentParser()
    parser.add_argument("csv_path", type=Path)
    parser.add_argument("--xlsx", type=Path, required=True)
    parser.add_argument("--pdf", type=Path, required=True)
    args = parser.parse_args()
    with args.csv_path.open(newline="", encoding="utf-8") as handle:
        rows = list(csv.reader(handle))
    if not rows:
        raise SystemExit("canonical CSV is empty")

    args.xlsx.parent.mkdir(parents=True, exist_ok=True)
    workbook = Workbook()
    sheet = workbook.active
    sheet.title = "Evidence Ledger"
    for row in rows:
        sheet.append(row)
    sheet.freeze_panes = "A2"
    sheet.auto_filter.ref = sheet.dimensions
    for cell in sheet[1]:
        font = copy(cell.font)
        font.bold = True
        font.color = "FFFFFF"
        cell.font = font
        fill = copy(cell.fill)
        fill.fill_type = "solid"
        fill.fgColor = "1F4E78"
        cell.fill = fill
    for column in sheet.columns:
        letter = column[0].column_letter
        sheet.column_dimensions[letter].width = min(max(max(len(str(cell.value or "")) for cell in column) + 2, 10), 42)
    workbook.save(args.xlsx)

    args.pdf.parent.mkdir(parents=True, exist_ok=True)
    styles = getSampleStyleSheet()
    doc = SimpleDocTemplate(str(args.pdf), pagesize=landscape(A4), leftMargin=10 * mm, rightMargin=10 * mm, topMargin=10 * mm, bottomMargin=10 * mm)
    story = [Paragraph("Selena AI Visibility — Evidence Ledger", styles["Title"]), Spacer(1, 5 * mm)]
    display_rows = [rows[0]] + [row[: min(len(rows[0]), 8)] for row in rows[1:51]]
    table = Table(display_rows, repeatRows=1)
    table.setStyle(TableStyle([
        ("BACKGROUND", (0, 0), (-1, 0), colors.HexColor("#1F4E78")),
        ("TEXTCOLOR", (0, 0), (-1, 0), colors.white),
        ("GRID", (0, 0), (-1, -1), 0.25, colors.HexColor("#B7C9D6")),
        ("FONTSIZE", (0, 0), (-1, -1), 6),
        ("VALIGN", (0, 0), (-1, -1), "TOP"),
    ]))
    story.append(table)
    story.append(Spacer(1, 4 * mm))
    story.append(Paragraph(f"Rows rendered: {len(rows) - 1}. PDF preview includes at most 50 rows; XLSX contains the complete ledger.", styles["BodyText"]))
    doc.build(story)


if __name__ == "__main__":
    main()
