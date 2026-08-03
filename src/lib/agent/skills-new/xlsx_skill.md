---
name: xlsx
description: Use whenever a spreadsheet file is the primary input or output: `.xlsx`, `.xlsm`, `.xls`, `.csv`, `.tsv`, Excel workbooks, data cleaning, formulas, charts, dashboards, model building, workbook repair, template editing, and tabular conversion. Final consumer deliverables should be real spreadsheet files unless the user explicitly asks for CSV/TSV.
license: Complete terms in LICENSE.txt
---

# XLSX / Excel Skill

Spreadsheets are working models, datasets, dashboards, or templates. They must remain editable, auditable, and useful after delivery.

## Core Rules

- Deliver the requested spreadsheet file type. Do not substitute Markdown tables or screenshots.
- Profile existing files before editing them.
- Preserve formulas, charts, validations, filters, formatting, protected ranges, and macros unless the user asks to change them.
- Use workbook structure appropriate to the task. Do not force every workbook into Inputs, Model, Dashboard, Charts.
- Use real data or clearly labeled user-editable inputs. Never invent financial, company, market, or operational numbers.
- Keep final workbooks outside `.workspaces/sandbox` unless explicitly requested.

## Choose The Right Path

| Task | Best Path |
|---|---|
| Simple table export | Office builder or pandas/openpyxl |
| Existing workbook edit | Load workbook, inspect sheets/ranges/formulas/charts, edit locally |
| Data cleaning | pandas for profiling/cleaning, then export structured workbook |
| Financial/model workbook | Inputs/assumptions, calculations, outputs, checks, sources as needed |
| Dashboard | Data/source sheet plus charts/KPIs only when useful |
| Template | Preserve layout and formulas; fill or extend expected input areas |
| Macro workbook | Preserve `.xlsm` and VBA package; do not save as plain `.xlsx` unless requested |

## Profiling Checklist

For existing files, inspect:

- Sheet names, dimensions, hidden sheets, freeze panes, filters, tables.
- Header rows, required columns, data types, missing values, duplicate keys.
- Formula cells, named ranges, validations, conditional formatting.
- Charts, drawings, images, comments/notes, pivots, protected areas.
- External links and source/date notes.

## Workbook Design

Use as much structure as the task deserves:

- Data sheet for raw/imported data when traceability matters.
- Cleaned sheet when transformations are nontrivial.
- Assumptions/input sheet when users should change variables.
- Calculations/model sheet when formulas should remain auditable.
- Output/dashboard sheet when the workbook is for executive scanning.
- Sources/notes/checks sheet when data is researched or formulas need QA.

Small tasks can be one well-formatted sheet. Enterprise models may need many sheets.

## Formula And Data Rules

- Use formulas for totals, percentages, margins, growth, variances, rankings, lookups, and scenario outputs when the workbook should remain dynamic.
- Use static values for source facts, imported data, or final fixed extracts.
- Keep units explicit in headers.
- Do not mix currencies, percentages, dates, and counts in one column.
- Guard blank-input templates against misleading totals and divide-by-zero errors.
- Recalculate formulas with Excel, LibreOffice, or a documented project tool when formulas are present. If no engine is available, say cached formula values were not verified.

## Charts And Dashboards

Add charts only when they help: time series, comparisons, shares, distributions, funnels, pipeline stages, or KPI movement.

Choose chart types deliberately:

- Line: trends.
- Bar/column: comparisons.
- Stacked bar/area: composition.
- Scatter: relationships.
- Histogram: distributions.
- Waterfall: bridges.
- Pie/donut: small share-of-total views only.

Charts must point to the intended ranges, have readable labels, and not cover source notes or inputs.

## Practical Commands And Libraries

```bash
pip install pandas openpyxl
```

Common Python stack:

- `pandas`: load, clean, join, reshape, profile.
- `openpyxl`: `.xlsx` formulas, formatting, validations, charts, comments.
- `xlsxwriter`: strong new-workbook formatting/chart generation.
- LibreOffice/Excel: formula recalculation and visual checking.

Useful checks:

```bash
python - <<'PY'
from openpyxl import load_workbook
wb = load_workbook('output.xlsx', data_only=False)
print(wb.sheetnames)
for ws in wb.worksheets:
    print(ws.title, ws.max_row, ws.max_column)
PY
```

## QA Gate

Before reporting completion:

- Final workbook exists, is non-trivial in size, and is at the requested/user-facing path.
- Expected sheets, row counts, headers, formulas, charts, and source notes are present.
- Required columns have headers and visible values.
- Formula cells do not obviously contain `#REF!`, `#DIV/0!`, `#VALUE!`, `#NAME?`, or `#N/A`.
- Charts/dashboards match source data and are readable.
- Existing workbook features were preserved unless intentionally changed.
- Final response gives the final spreadsheet path and states any recalculation or visual-preview limitation.
