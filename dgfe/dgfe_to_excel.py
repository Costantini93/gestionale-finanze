#!/usr/bin/env python3
"""
Unisce tutti i file DGFE (giornale di fondo elettronico) il cui nome finisce
con "BAR" in un unico foglio Excel, una riga per ogni articolo venduto.

Uso (Windows):
    python dgfe_to_excel.py "C:\\Users\\alessandro.costantin\\Desktop\\DGFE PIANI DI CLODIA"

Senza argomenti usa la cartella in cui si trova lo script.
Il file Excel "DGFE_BAR.xlsx" viene creato nella stessa cartella dei DGFE.
Richiede: pip install openpyxl
"""
import re
import sys
from datetime import datetime
from pathlib import Path

from openpyxl import Workbook
from openpyxl.styles import Alignment, Font, PatternFill
from openpyxl.utils import get_column_letter

RE_ITEM = re.compile(r"^\s(\S.*?)\s+(\d+,\d+)%\s+(-?\d+(?:\.\d{3})*,\d{2})\s*$")
RE_QTY = re.compile(r"^\s+(\d+(?:,\d+)?)\s+x\s+(\d+(?:\.\d{3})*,\d{2})\s*$")
RE_DATETIME = re.compile(r"^\s+(\d{2}-\d{2}-\d{4})\s+(\d{2}:\d{2})\s*$")
RE_DOCNUM = re.compile(r"DOCUMENTO N\.\s*(\d+-\d+)")
RE_AMOUNT = re.compile(r"^\s(\S.*?)\s{2,}(-?\d+(?:\.\d{3})*,\d{2})\s*$")


def num(s):
    return float(s.replace(".", "").replace(",", "."))


def parse_file(path):
    text = path.read_bytes().decode("cp1252", errors="replace")
    blocks = re.split(r"^\s*DOCUMENTO\s+COMMERCIALE\s*$", text, flags=re.M)[1:]
    rows = []
    for block in blocks:
        doc = {"items": [], "pagamento": "", "totale": None, "iva": None,
               "data": None, "ora": "", "numero": "", "note": []}
        pending_qty = None
        in_items = False
        in_payment_detail = False
        for line in block.splitlines():
            if not line.strip():
                continue
            if "DESCRIZIONE" in line and "IVA" in line:
                in_items = True
                continue
            m = RE_DATETIME.match(line)
            if m:
                doc["data"] = datetime.strptime(m.group(1), "%d-%m-%Y").date()
                doc["ora"] = m.group(2)
                continue
            m = RE_DOCNUM.search(line)
            if m:
                doc["numero"] = m.group(1)
                continue
            if "DETTAGLIO FORME di PAGAMENTO" in line:
                in_payment_detail = True
                continue
            if in_payment_detail:
                m = RE_AMOUNT.match(line)
                if m and not line.strip().startswith(("Importo:", "Data:")):
                    doc["pagamento"] = (doc["pagamento"] + " + " if doc["pagamento"] else "") + m.group(1).strip()
                continue
            if in_items:
                m = RE_QTY.match(line)
                if m:
                    pending_qty = (num(m.group(1)), num(m.group(2)))
                    continue
                m = RE_ITEM.match(line)
                if m:
                    importo = num(m.group(3))
                    qty, unit = pending_qty if pending_qty else (1, importo)
                    doc["items"].append({"descr": m.group(1).strip(), "iva": num(m.group(2)),
                                         "qty": qty, "unit": unit, "importo": importo, "note": ""})
                    pending_qty = None
                    continue
                s = line.strip()
                if s.startswith("SUBTOTALE"):
                    continue
                if s.startswith("TOTALE COMPLESSIVO"):
                    doc["totale"] = num(s.split()[-1])
                    in_items = False
                    continue
                # riga senza prezzo (es. variante "GHIACCIO"): nota sull'ultimo articolo
                if doc["items"]:
                    it = doc["items"][-1]
                    it["note"] = (it["note"] + ", " if it["note"] else "") + s
                else:
                    doc["note"].append(s)
                continue
            s = line.strip()
            if s.startswith("di cui IVA"):
                doc["iva"] = num(s.split()[-1])
        for i, it in enumerate(doc["items"]):
            rows.append([
                doc["data"], doc["ora"], doc["numero"], it["descr"], it["note"],
                it["qty"], it["unit"], it["importo"], it["iva"] / 100,
                doc["totale"] if i == 0 else None,
                doc["iva"] if i == 0 else None,
                doc["pagamento"], path.name,
            ])
    return rows


def main():
    folder = Path(sys.argv[1]) if len(sys.argv) > 1 else Path(__file__).resolve().parent
    out = Path(sys.argv[2]) if len(sys.argv) > 2 else folder / "DGFE_BAR.xlsx"
    files = sorted(p for p in folder.iterdir() if p.is_file() and p.name.upper().endswith("BAR"))
    if not files:
        print(f"Nessun file che finisce con BAR in {folder}")
        return
    rows = []
    for f in files:
        r = parse_file(f)
        print(f"{f.name}: {len(r)} righe")
        rows.extend(r)
    rows.sort(key=lambda r: (r[0] or datetime.min.date(), r[1], r[2]))

    wb = Workbook()
    ws = wb.active
    ws.title = "DGFE BAR"
    headers = ["Data", "Ora", "N. documento", "Descrizione", "Note", "Quantità",
               "Prezzo unit. €", "Importo €", "Aliquota IVA", "Totale scontrino €",
               "di cui IVA €", "Pagamento", "File"]
    ws.append(headers)
    for r in rows:
        ws.append(r)
    n = len(rows) + 1
    ws.append([])
    ws.append(["TOTALE", None, None, None, None, f"=SUM(F2:F{n})", None,
               f"=SUM(H2:H{n})", None, f"=SUM(J2:J{n})", f"=SUM(K2:K{n})"])

    bold = Font(bold=True, color="FFFFFF")
    fill = PatternFill("solid", fgColor="1F4E78")
    for c in ws[1]:
        c.font, c.fill = bold, fill
        c.alignment = Alignment(horizontal="center", vertical="center", wrap_text=True)
    for c in ws[n + 2]:
        c.font = Font(bold=True)
    for row in ws.iter_rows(min_row=2, max_row=n + 2):
        row[0].number_format = "DD/MM/YYYY"
        for idx in (6, 7, 9, 10):
            row[idx].number_format = "#,##0.00"
        row[8].number_format = "0%"
    widths = [11, 7, 13, 26, 14, 9, 12, 11, 10, 14, 11, 14, 22]
    for i, w in enumerate(widths, 1):
        ws.column_dimensions[get_column_letter(i)].width = w
    ws.freeze_panes = "A2"
    ws.auto_filter.ref = f"A1:M{n}"
    wb.save(out)
    print(f"\nCreato {out} ({len(rows)} righe da {len(files)} file)")


if __name__ == "__main__":
    main()
