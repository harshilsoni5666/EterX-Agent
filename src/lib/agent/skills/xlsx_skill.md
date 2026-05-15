---
name: xlsx
description: "Use this skill any time a spreadsheet file is the primary input or output. This means any task where the user wants to: open, read, edit, or fix an existing .xlsx, .xlsm, .csv, or .tsv file (e.g., adding columns, computing formulas, formatting, charting, cleaning messy data); create a new spreadsheet from scratch or from other data sources; or convert between tabular file formats. Trigger especially when the user references a spreadsheet file by name or path — even casually (like \"the xlsx in my downloads\") — and wants something done to it or produced from it. Also trigger for cleaning or restructuring messy tabular data files (malformed rows, misplaced headers, junk data) into proper spreadsheets. The deliverable must be a spreadsheet file. Do NOT trigger when the primary deliverable is a Word document, HTML report, standalone Python script, database pipeline, or Google Sheets API integration, even if tabular data is involved."
license: Proprietary. LICENSE.txt has complete terms
---

# Requirements for Outputs

## EterX Office Artifact Protocol

For ordinary new spreadsheets, use `office_artifact_builder(format="xlsx")` before writing a one-off Python/openpyxl script.

1. Use `.workspaces/sandbox` only for internal research notes, cleaned intermediate tables, or staging data.
2. Export the final `.xlsx` to the exact user-requested path, or to the Desktop for relative filenames.
3. Share only the final `.xlsx` path in the answer. Do not expose sandbox CSVs, scratch scripts, or temporary data files unless requested.
4. Use custom Python/openpyxl only for advanced workbooks: formulas, charts, pivots, multiple dashboards, conditional formatting, template editing, macros, or existing-file transformations.
5. A spreadsheet deliverable must be a real workbook, not a text/Markdown table. CSV/TSV can be an intermediate input format, but the final consumer artifact should be `.xlsx` unless the user explicitly requests CSV/TSV.

Sandbox rule: `.workspaces/sandbox` is only for intermediate tables, research notes, and scratch data. The final workbook must be written to Desktop or the user-requested real path.

The agent owns data quality, schema, formulas, and analysis. The system builder owns baseline workbook packaging and final file placement.

## Codex-Grade Spreadsheet Workflow

Use this workflow for every real workbook:

1. Profile first: file type, sheets, dimensions, headers, data types, missing values, duplicate keys, formulas, charts, and obvious schema problems.
2. Decide workbook architecture from the task: Summary/Dashboard, Inputs, Assumptions, Data, Cleaned Data, Calculations, Sources, Checks, Exceptions, or Appendix.
3. Build with structured workbook APIs or the office builder. Use custom spreadsheet code only when advanced formulas, charts, validations, existing-file edits, pivots, dashboards, or template preservation require it.
4. Keep raw/source data separate from cleaned/derived data when transforming user files.
5. Use native Excel features for user value: formulas, tables, filters, freeze panes, data validation, conditional formatting, comments/notes, charts, source sheets, and check sheets.
6. Inspect key ranges and formula outputs before export. Render or visually inspect dashboards/charts when possible.
7. Export one final `.xlsx` to the requested path or Desktop, and do not present scratch CSV/Markdown/scripts as the final artifact.

### Workbook Verification Gate

- Every required column has a non-empty header.
- Important names/labels are not missing from data rows.
- Formulas reference the intended rows and columns, with correct absolute/relative references.
- Charts point to the intended data ranges and are not blank.
- Formatting is applied across all relevant sheets, not only the first sheet.
- Key values are visible at normal zoom: headers, names, dates, currency, percentages, totals, chart labels, and source notes.
- Current or researched data has source/date notes.

### Codex Spreadsheet Parity Rules

- Prefer block writes and structured workbook operations over cell-by-cell scripts for large ranges. Create sheets before formulas that reference them.
- For existing workbooks, inspect first. Identify sheets, used ranges, tables, formulas, drawings/charts, comments, protected areas, named ranges, and source data before editing.
- For edits, make the smallest local change that satisfies the request while preserving formulas, tables, validations, conditional formatting, filters, and charts. Extend dependent ranges when adding rows or columns.
- For formula work, seed formulas once and fill down/right when possible. Use bounded ranges instead of whole-column references inside `SUMIFS`, `COUNTIFS`, lookups, and model formulas.
- For templates, formulas should guard blank inputs so empty templates do not show misleading rankings, errors, or fake totals.
- For dashboards, reserve chart areas and delete or replace old drawings deliberately. Do not let charts cover data or source notes.
- For comments/notes, attach them to the exact cells they explain, especially assumptions, sources, manual overrides, and unusual calculations.
- Verification must include: compact sheet/range inspection, formula-error scan, chart existence/range check, and a visual sheet/dashboard pass when rendering or preview is available.
- If workbook tooling cannot render or inspect visually, do not claim perfect layout. State the limitation and still verify package structure, formulas, sheet names, dimensions, and file size.

## Senior Spreadsheet Intelligence

A workbook is an interactive decision system, not a static table.

### Small Prompt Expansion Protocol

When the user gives a short or messy spreadsheet request, infer the professional deliverable they actually need. Do not ask for clarification unless the task is impossible or risky.

| User says | Build this |
|-----------|------------|
| "make excel of top companies" | Summary sheet, ranked company data, metrics columns, sources/notes |
| "create budget xlsx" | Inputs/Assumptions, Budget, Summary, simple formulas |
| "make tracker" | Data-entry sheet, status/category fields, summary counts |
| "convert this table to xlsx" | Clean data sheet, frozen headers, filters, widths, source note |
| "sales report xlsx" | Summary KPIs, Sales Data, region/product breakdown, formulas |

Default behavior for small prompts:
- Create a meaningful workbook title and filename from the request.
- Put a `Summary` or dashboard-like sheet first.
- Put raw or cleaned data in separate sheets.
- Add source/assumption rows or sheets when data comes from research.
- Use formulas for totals, percentages, margins, growth, variances, and rankings whenever the workbook should stay editable.
- Keep final files out of `.workspaces/sandbox`; sandbox is only for staging.

### Tool Choice

Use `office_artifact_builder(format="xlsx")` for normal workbook exports from structured sheet data or Markdown tables. It now produces baseline professional workbooks with:

- Summary sheet
- Frozen header rows
- Auto-filters
- Sized columns
- Styled headers and alternating rows
- Formula cells when values start with `=`
- Workbook recalculation flags

Use custom `openpyxl`/Python only when the result needs charts, validations, dashboard cards, pivots, formulas across many sheets, conditional formatting, external-file editing, or exact template preservation.

### Coverage Matrix For Professional XLSX Work

Handle these workbook classes deliberately:

| Workbook class | Required sheets | Required behavior |
|----------------|-----------------|-------------------|
| Market/company list | Summary, Data, Sources | Ranking, sector/category fields, source/date notes |
| Financial model | Inputs, Assumptions, Model, Scenarios, Summary | Linked formulas, editable assumptions, no hardcoded calculated outputs |
| KPI dashboard | Summary/Dashboard, Data, Calculations, Sources | KPI cards or summary rows, trend/comparison formulas |
| Tracker | Dashboard, Tracker, Lists/Validation | Status/category columns, counts by status, clear editable fields |
| Data cleaning | Original, Cleaned, Rejected, Validation Summary | Preserve raw data, document rules, no silent row loss |
| Operations report | Summary, Detail, Exceptions | Totals, overdue/exception flags, owner/status fields |
| Inventory/logistics | Summary, Inventory, Reorder, Suppliers | Reorder formulas, stock risk flags, lead-time assumptions |
| Project plan | Timeline, Tasks, Resources, Risks | Dates, owners, dependencies, progress fields |
| Academic/research data | Data, Codebook, Sources, Notes | Units, methodology, citation/source fields |
| Personal finance | Budget, Transactions, Categories, Summary | Category totals, monthly totals, editable inputs |

For every class, choose sheet names that describe the actual data. Avoid generic `Sheet1` unless the user gave no topic and no better name is defensible.

### Minimum Professional Workbook Contract

Every newly generated `.xlsx` should satisfy this unless the user explicitly asks for a raw export:

1. First sheet is `Summary` or a dashboard-like overview.
2. Data sheets have clear headers, frozen header row, filters, and readable column widths.
3. Numeric columns are formatted as numbers, currency, dates, or percentages based on header meaning.
4. Formula cells remain formulas, not precomputed values.
5. External data has a source/date note.
6. Final output is `.xlsx`, not `.csv`, `.md`, or a scratch script.
7. The final file path is outside `.workspaces/sandbox`.

### Full Excel Power Rules

For professional workbooks, use as much of Excel's native capability as the task deserves:

- Charts: If there are 3+ rows and at least one numeric comparison/trend column, include a real Excel chart or use custom `openpyxl` chart creation. Do not fake charts as images or text.
- Formulas: Use Excel formulas for totals, margins, growth, variance, ranks, percentages, scenario outputs, and dashboard metrics.
- Formatting: Apply formatting across every sheet, not only the first table. Headers, widths, filters, freeze panes, number formats, dates, and readable wrapping must be consistent.
- Visibility: Make all text visible. Auto-size columns, wrap long headers/notes, avoid hidden overflow, and keep important values near the left/top of sheets.
- Summary: Include a first-sheet summary/dashboard for any workbook with more than one table or more than 20 data rows.
- Sources: Include source/date/assumption fields for researched or current data. A workbook with current facts but no sources is incomplete.
- QA: Check the package exists, is non-trivial, opens structurally, and has the expected sheet names, row counts, formula cells, and charts when charts are appropriate.

### Handling Insufficient User Detail

If the user gives a vague prompt, make conservative assumptions and encode them in the workbook:

- Use an `Assumptions` or `Sources` sheet for inferred assumptions.
- Use broad but useful columns rather than asking first: name, category, metric/value, date, notes/source.
- For current market/company/finance tasks, research enough to avoid fake numbers.
- If no real data is available, create a structured template with editable input columns and formulas rather than pretending values are factual.

### Workbook Architecture

Pick the shape from the job:

| Intent | Workbook Shape | What Makes It Excellent |
|--------|----------------|-------------------------|
| Simple list/report | Data sheet plus summary sheet | Clean schema, filters, widths, freeze panes |
| Financial model | Inputs, assumptions, calculations, scenarios, dashboard | Formulas, auditability, sensitivity analysis |
| Market/company report | Raw data, cleaned data, metrics, charts, sources | Traceable data and source notes |
| Operations tracker | Data entry, validation, status dashboard, exceptions | Usable dropdowns, conditional formatting |
| Data cleaning | Original, cleaned, rejected rows, validation summary | No silent data loss |
| KPI dashboard | Inputs/data, KPI cards, trend charts, notes | Fast executive scanning |

### Data Quality Rules

- Preserve raw data when transforming user-provided files.
- Make assumptions explicit in an assumptions/source sheet.
- Never invent missing rows, company names, financial values, marketing spend, or formulas. If a required source is missing, build the workbook from available evidence and add a clear missing-data note.
- For researched/current data, record source names/URLs/dates and keep assumptions separate from facts.
- Use formulas for derived values when the workbook should remain updateable.
- Use static values only for historical facts, source data, or final exports where formulas are not useful.
- Never mix units in a column. Put currency, percentage, dates, and counts in their own columns.
- Use consistent date formats and numeric formatting.
- If data came from the web, record source URL/name/date in the workbook.

### UX Rules

- Freeze headers on every data sheet.
- Auto-fit columns enough for scanning.
- Use clear sheet names, not Sheet1/Sheet2 unless unavoidable.
- Use color sparingly: inputs, formulas, warnings, and sections.
- Add validation/dropdowns for fields users will edit repeatedly.
- Put the user-facing dashboard or summary first for business workbooks.

### Chart And Dashboard Rules

- If the workbook has time series, comparisons, market share, distributions, funnel stages, pipeline status, or KPI movement, add charts or a dashboard when custom spreadsheet tooling is used.
- Use chart types deliberately: line for trends, bar for comparisons, stacked bar for composition over categories, scatter for relationships, histogram for distribution, waterfall for bridges, and donut/pie only for small share-of-total views.
- Keep raw data, cleaned data, calculations, and dashboard separate so the workbook can be audited.
- For externally sourced data, include a Sources sheet with URL/name/date and any caveats.
- If a final report also needs DOCX/PDF/PPTX, generate the workbook first, then reuse its charts/tables as source assets for the other Office artifacts.

### Spreadsheet QA

Before reporting completion:

1. Verify the final `.xlsx` exists and is not tiny.
2. Verify the final `.xlsx` is outside `.workspaces/sandbox` unless the user explicitly requested that location.
3. Verify sheet names and row/column counts match the requested deliverable.
4. Verify formulas, source notes, and assumptions are present when needed.
5. Verify no scratch CSV/TSV/Markdown file is presented as final output.
6. Verify charts/dashboards match the underlying data if they were created.
7. Verify there are no missing header names, blank required name fields, or formatting applied only to the first sheet when multiple sheets exist.
8. Verify no obvious formula errors exist in key output ranges.
9. Share only the final `.xlsx` path unless the user asks for intermediate data.

## Professional Content Standards

**A spreadsheet with fake numbers is useless.** If the user asks for a financial model, use real data.

### 🚨 Hard Quality Rules — Check Before Saving
1. **Search first** — For any company/industry data, use web search to get real figures. Never invent financial data.
2. **Multi-sheet architecture** — Tab 1: Inputs/Assumptions (blue text), Tab 2: Model (black formulas), Tab 3: Dashboard (summary KPIs), Tab 4: Charts. Never dump everything in one sheet.
3. **Excel formulas only** — `sheet['B10'] = '=SUM(B2:B9)'` not `sheet['B10'] = 4200`. The model must recalculate on data change.
4. **Always freeze header rows** — `sheet.freeze_panes = 'A2'` on every data sheet.
5. **Always auto-fit column widths** — Run `auto_width(sheet)` after writing every sheet.
6. **Always run recalc** — `python scripts/recalc.py output.xlsx` must return `status: success` with 0 errors before delivery.
7. **Color code inputs vs formulas** — Blue text = user input, Black text = formula (industry standard).
8. **Scratch vs final** — Use `.workspaces/sandbox/` only for intermediate staging. Final user-facing workbooks go to the requested path or Desktop.

### Advanced Workbook Patterns

#### Pattern A: KPI Dashboard Tab
```python
from openpyxl import Workbook
from openpyxl.styles import Font, PatternFill, Alignment, Border, Side
from openpyxl.utils import get_column_letter

PRIMARY = '1E3A5F'
ACCENT  = '2E86AB'
GREEN   = '27AE60'
RED     = 'E74C3C'
LIGHT   = 'F0F4F8'
WHITE   = 'FFFFFF'

def add_kpi_card(ws, row, col, label, value, delta, is_positive=True):
    """Adds a 3-row KPI card starting at (row, col), spanning 2 columns."""
    delta_color = GREEN if is_positive else RED
    # Card background (merge 2x3 area)
    for r in range(row, row+3):
        for c in range(col, col+3):
            cell = ws.cell(r, c)
            cell.fill = PatternFill('solid', fgColor=PRIMARY)
            cell.border = Border(
                left=Side('thin', color=ACCENT), right=Side('thin', color=ACCENT),
                top=Side('thin', color=ACCENT), bottom=Side('thin', color=ACCENT)
            )
    # Label
    lbl = ws.cell(row, col, label)
    lbl.font = Font(name='Calibri', size=10, color='CADCFC')
    lbl.alignment = Alignment(horizontal='center', vertical='center')
    ws.merge_cells(start_row=row, start_column=col, end_row=row, end_column=col+2)
    # Value
    val = ws.cell(row+1, col, value)
    val.font = Font(name='Calibri', size=24, bold=True, color=WHITE)
    val.alignment = Alignment(horizontal='center', vertical='center')
    ws.merge_cells(start_row=row+1, start_column=col, end_row=row+1, end_column=col+2)
    # Delta
    dlt = ws.cell(row+2, col, delta)
    dlt.font = Font(name='Calibri', size=10, bold=True, color=delta_color)
    dlt.alignment = Alignment(horizontal='center', vertical='center')
    ws.merge_cells(start_row=row+2, start_column=col, end_row=row+2, end_column=col+2)

def build_dashboard(wb, kpis):
    """kpis = [{'label': 'Revenue', 'value': '$4.2B', 'delta': '+31% YoY', 'up': True}, ...]"""
    ws = wb.create_sheet('Dashboard', 0)
    ws.sheet_view.showGridLines = False
    ws.column_dimensions['A'].width = 2  # left margin
    # Title bar
    ws.row_dimensions[1].height = 40
    ws.merge_cells('B1:P1')
    title = ws['B1']
    title.value = 'EXECUTIVE DASHBOARD'
    title.font = Font(name='Calibri', size=20, bold=True, color=WHITE)
    title.fill = PatternFill('solid', fgColor=PRIMARY)
    title.alignment = Alignment(horizontal='center', vertical='center')
    # KPI cards (3 per row, 4 cols wide each with spacer)
    for i, kpi in enumerate(kpis):
        col = 2 + (i % 3) * 5
        row = 3 + (i // 3) * 5
        ws.row_dimensions[row].height = 18
        ws.row_dimensions[row+1].height = 35
        ws.row_dimensions[row+2].height = 18
        add_kpi_card(ws, row, col, kpi['label'], kpi['value'], kpi['delta'], kpi['up'])
    return ws
```

#### Pattern B: Auto-Width + Freeze + Style (apply to every sheet)
```python
def style_sheet(ws, header_row=1):
    """Apply professional formatting to any sheet."""
    THIN = Side(style='thin', color='D1D5DB')
    BORDER = Border(left=THIN, right=THIN, top=THIN, bottom=THIN)
    HDR_FILL = PatternFill('solid', fgColor='1E3A5F')
    HDR_FONT = Font(name='Calibri', bold=True, color='FFFFFF', size=11)

    # Style header row
    for cell in ws[header_row]:
        cell.fill = HDR_FILL
        cell.font = HDR_FONT
        cell.alignment = Alignment(horizontal='center', vertical='center', wrap_text=True)
        cell.border = BORDER
    ws.row_dimensions[header_row].height = 28

    # Style data rows with alternating colors
    for row_idx, row in enumerate(ws.iter_rows(min_row=header_row+1), start=1):
        fill_color = 'FFFFFF' if row_idx % 2 == 0 else 'F8FAFC'
        for cell in row:
            cell.fill = PatternFill('solid', fgColor=fill_color)
            cell.border = BORDER
            cell.alignment = Alignment(vertical='center')

    # Freeze header
    ws.freeze_panes = f'A{header_row+1}'

    # Auto-fit columns
    for col in ws.columns:
        max_len = max((len(str(c.value or '')) for c in col), default=8)
        ws.column_dimensions[get_column_letter(col[0].column)].width = min(max_len + 4, 45)
```

#### Pattern C: Data Validation Dropdown
```python
from openpyxl.worksheet.datavalidation import DataValidation
# Dropdown list for a column
dv = DataValidation(
    type='list',
    formula1='"Q1 2025,Q2 2025,Q3 2025,Q4 2025"',
    allow_blank=True,
    showDropDown=False,  # False = show dropdown arrow
    error='Please select a valid quarter.',
    errorTitle='Invalid Input',
    prompt='Select a quarter from the list.',
)
ws.add_data_validation(dv)
dv.add('A2:A100')
```

#### Pattern D: Conditional Formatting (Color Scales/Icon Sets)
```python
from openpyxl.formatting.rule import ColorScaleRule, IconSetRule
# 3-Color Scale (Red-Yellow-Green)
color_rule = ColorScaleRule(
    start_type='min', start_color='F8696B',
    mid_type='percentile', mid_value=50, mid_color='FFEB84',
    end_type='max', end_color='63BE7B'
)
ws.conditional_formatting.add('B2:B100', color_rule)

# Icon Set (Arrows)
icon_rule = IconSetRule('3Arrows', 'percent', [0, 33, 67], showValue=True)
ws.conditional_formatting.add('C2:C100', icon_rule)
```

#### Pattern E: Named Ranges (Best Practice for Models)
```python
from openpyxl.workbook.defined_name import DefinedName
# Define a name for a constant (e.g. Tax Rate)
new_name = DefinedName('TaxRate', attr_text='Inputs!$B$5')
wb.defined_names.add(new_name)
# Now use =TaxRate in any formula: sheet['C10'] = '=B10*TaxRate'
```

---

## 🏆 Advanced Industry Use Cases

### 1. The Cap Table (Startup Equity)
*   **Tab 1: Summary**: Pie chart showing ownership % post-dilution.
*   **Tab 2: Shareholders**: List of investors, shares, price per share, and liquidation preference.
*   **Tab 3: Option Pool**: Tracking employee stock options (ISO/NSO).
*   **Tab 4: Scenario Analysis**: Using Data Tables to show "Exit Value" vs "Investor Returns".

### 2. Monte Carlo Simulation (Risk Analysis)
*   **Concept**: Running 1,000+ iterations of a model to find a range of outcomes.
*   **Implementation**: Use Python to generate random distributions, write them to a hidden tab, then use Excel's `PERCENTILE` formulas to show "95% Confidence Interval" on the Dashboard.

### 3. Inventory & Logistics Management
*   **Automatic Reorder Points**: Conditional formatting (Red) when `Stock < Safety_Stock`.
*   **Lead Time Analysis**: Formulas to calculate `Expected_Delivery_Date` based on historical lead times.
*   - **Dashboard**: High-level view of "Total Inventory Value" and "Out of Stock Items".

---


## All Excel files

### Professional Font
- Use a consistent, professional font (e.g., Arial, Times New Roman) for all deliverables unless otherwise instructed by the user

### Zero Formula Errors
- Every Excel model MUST be delivered with ZERO formula errors (#REF!, #DIV/0!, #VALUE!, #N/A, #NAME?)

### Preserve Existing Templates (when updating templates)
- Study and EXACTLY match existing format, style, and conventions when modifying files
- Never impose standardized formatting on files with established patterns
- Existing template conventions ALWAYS override these guidelines

## Financial models

### Color Coding Standards
Unless otherwise stated by the user or existing template

#### Industry-Standard Color Conventions
- **Blue text (RGB: 0,0,255)**: Hardcoded inputs, and numbers users will change for scenarios
- **Black text (RGB: 0,0,0)**: ALL formulas and calculations
- **Green text (RGB: 0,128,0)**: Links pulling from other worksheets within same workbook
- **Red text (RGB: 255,0,0)**: External links to other files
- **Yellow background (RGB: 255,255,0)**: Key assumptions needing attention or cells that need to be updated

### Number Formatting Standards

#### Required Format Rules
- **Years**: Format as text strings (e.g., "2024" not "2,024")
- **Currency**: Use $#,##0 format; ALWAYS specify units in headers ("Revenue ($mm)")
- **Zeros**: Use number formatting to make all zeros "-", including percentages (e.g., "$#,##0;($#,##0);-")
- **Percentages**: Default to 0.0% format (one decimal)
- **Multiples**: Format as 0.0x for valuation multiples (EV/EBITDA, P/E)
- **Negative numbers**: Use parentheses (123) not minus -123

### Formula Construction Rules

#### Assumptions Placement
- Place ALL assumptions (growth rates, margins, multiples, etc.) in separate assumption cells
- Use cell references instead of hardcoded values in formulas
- Example: Use =B5*(1+$B$6) instead of =B5*1.05

#### Formula Error Prevention
- Verify all cell references are correct
- Check for off-by-one errors in ranges
- Ensure consistent formulas across all projection periods
- Test with edge cases (zero values, negative numbers)
- Verify no unintended circular references

#### Documentation Requirements for Hardcodes
- Comment or in cells beside (if end of table). Format: "Source: [System/Document], [Date], [Specific Reference], [URL if applicable]"
- Examples:
  - "Source: Company 10-K, FY2024, Page 45, Revenue Note, [SEC EDGAR URL]"
  - "Source: Company 10-Q, Q2 2025, Exhibit 99.1, [SEC EDGAR URL]"
  - "Source: Bloomberg Terminal, 8/15/2025, AAPL US Equity"
  - "Source: FactSet, 8/20/2025, Consensus Estimates Screen"

# XLSX creation, editing, and analysis

## Overview

A user may ask you to create, edit, or analyze the contents of an .xlsx file. You have different tools and workflows available for different tasks.

## Important Requirements

**LibreOffice Required for Formula Recalculation**: You can assume LibreOffice is installed for recalculating formula values using the `scripts/recalc.py` script. The script automatically configures LibreOffice on first run, including in sandboxed environments where Unix sockets are restricted (handled by `scripts/office/soffice.py`)

## Reading and analyzing data

### Data analysis with pandas
For data analysis, visualization, and basic operations, use **pandas** which provides powerful data manipulation capabilities:

```python
import pandas as pd

# Read Excel
df = pd.read_excel('file.xlsx')  # Default: first sheet
all_sheets = pd.read_excel('file.xlsx', sheet_name=None)  # All sheets as dict

# Analyze
df.head()      # Preview data
df.info()      # Column info
df.describe()  # Statistics

# Write Excel
df.to_excel('output.xlsx', index=False)
```

## Excel File Workflows

## CRITICAL: Use Formulas, Not Hardcoded Values

**Always use Excel formulas instead of calculating values in Python and hardcoding them.** This ensures the spreadsheet remains dynamic and updateable.

### ❌ WRONG - Hardcoding Calculated Values
```python
# Bad: Calculating in Python and hardcoding result
total = df['Sales'].sum()
sheet['B10'] = total  # Hardcodes 5000

# Bad: Computing growth rate in Python
growth = (df.iloc[-1]['Revenue'] - df.iloc[0]['Revenue']) / df.iloc[0]['Revenue']
sheet['C5'] = growth  # Hardcodes 0.15

# Bad: Python calculation for average
avg = sum(values) / len(values)
sheet['D20'] = avg  # Hardcodes 42.5
```

### ✅ CORRECT - Using Excel Formulas
```python
# Good: Let Excel calculate the sum
sheet['B10'] = '=SUM(B2:B9)'

# Good: Growth rate as Excel formula
sheet['C5'] = '=(C4-C2)/C2'

# Good: Average using Excel function
sheet['D20'] = '=AVERAGE(D2:D19)'
```

This applies to ALL calculations - totals, percentages, ratios, differences, etc. The spreadsheet should be able to recalculate when source data changes.

## Common Workflow
1. **Choose tool**: pandas for data, openpyxl for formulas/formatting
2. **Create/Load**: Create new workbook or load existing file
3. **Modify**: Add/edit data, formulas, and formatting
4. **Save**: Write to file
5. **Recalculate formulas (MANDATORY IF USING FORMULAS)**: Use the scripts/recalc.py script
   ```bash
   python scripts/recalc.py output.xlsx
   ```
6. **Verify and fix any errors**: 
   - The script returns JSON with error details
   - If `status` is `errors_found`, check `error_summary` for specific error types and locations
   - Fix the identified errors and recalculate again
   - Common errors to fix:
     - `#REF!`: Invalid cell references
     - `#DIV/0!`: Division by zero
     - `#VALUE!`: Wrong data type in formula
     - `#NAME?`: Unrecognized formula name

### Creating new Excel files

```python
from openpyxl import Workbook
from openpyxl.styles import Font, PatternFill, Alignment, Border, Side
from openpyxl.utils import get_column_letter

wb = Workbook()
sheet = wb.active
sheet.title = 'Report'

# Add data
sheet['A1'] = 'Hello'
sheet['B1'] = 'World'
sheet.append(['Row', 'of', 'data'])

# Add formula
sheet['B2'] = '=SUM(A1:A10)'

# Formatting
sheet['A1'].font = Font(bold=True, color='FF0000')
sheet['A1'].fill = PatternFill('solid', start_color='FFFF00')
sheet['A1'].alignment = Alignment(horizontal='center')

# Column width
sheet.column_dimensions['A'].width = 20

wb.save('output.xlsx')
```

### Professional Workbook Template
```python
from openpyxl import Workbook
from openpyxl.styles import (
    Font, PatternFill, Alignment, Border, Side, GradientFill
)
from openpyxl.utils import get_column_letter
from openpyxl.chart import BarChart, Reference
from openpyxl.styles.differential import DifferentialStyle
from openpyxl.formatting.rule import ColorScaleRule, DataBarRule

PRIMARY_HEX = '1E3A5F'
ACCENT_HEX  = '2E86AB'
LIGHT_HEX   = 'F0F4F8'
HEADER_FONT = Font(name='Calibri', bold=True, color='FFFFFF', size=11)
HEADER_FILL = PatternFill('solid', fgColor=PRIMARY_HEX)
HEADER_ALIGN = Alignment(horizontal='center', vertical='center', wrap_text=True)
THIN = Side(style='thin', color='D1D5DB')
BORDER = Border(left=THIN, right=THIN, top=THIN, bottom=THIN)

def style_header_row(sheet, row, cols):
    for col in range(1, cols + 1):
        cell = sheet.cell(row=row, column=col)
        cell.font = HEADER_FONT
        cell.fill = HEADER_FILL
        cell.alignment = HEADER_ALIGN
        cell.border = BORDER

def auto_width(sheet):
    for col in sheet.columns:
        max_len = max((len(str(c.value or '')) for c in col), default=10)
        sheet.column_dimensions[get_column_letter(col[0].column)].width = min(max_len + 4, 50)

def freeze_header(sheet, row=2):
    sheet.freeze_panes = f'A{row}'  # Freeze rows above row 2

def build_workbook():
    wb = Workbook()

    # — Sheet 1: Data
    ws = wb.active
    ws.title = 'Data'
    ws.row_dimensions[1].height = 30

    headers = ['Quarter', 'Revenue ($M)', 'Expenses ($M)', 'Net Profit ($M)', 'Margin %']
    ws.append(headers)
    style_header_row(ws, 1, len(headers))
    freeze_header(ws, row=2)

    rows = [
        ['Q1 2025', 1.2, 0.9, None, None],
        ['Q2 2025', 1.5, 1.0, None, None],
        ['Q3 2025', 1.8, 1.1, None, None],
        ['Q4 2025', 2.1, 1.2, None, None],
    ]
    for i, row in enumerate(rows, start=2):
        ws.append(row)
        ws[f'D{i}'] = f'=B{i}-C{i}'
        ws[f'E{i}'] = f'=D{i}/B{i}'
        ws[f'E{i}'].number_format = '0.0%'
        ws[f'B{i}'].number_format = '$#,##0.0'
        ws[f'C{i}'].number_format = '$#,##0.0'
        ws[f'D{i}'].number_format = '$#,##0.0'
        # Alternating row colors
        fill_color = 'FFFFFF' if i % 2 == 0 else LIGHT_HEX
        for col in range(1, 6):
            cell = ws.cell(row=i, column=col)
            cell.fill = PatternFill('solid', fgColor=fill_color)
            cell.border = BORDER
            cell.alignment = Alignment(horizontal='center')

    # Totals row
    last = len(rows) + 1
    ws.append(['TOTAL', f'=SUM(B2:B{last})', f'=SUM(C2:C{last})', f'=SUM(D2:D{last})', ''])
    for col in range(1, 6):
        cell = ws.cell(row=last+1, column=col)
        cell.font = Font(bold=True, name='Calibri')
        cell.fill = PatternFill('solid', fgColor=ACCENT_HEX)
        cell.font = Font(bold=True, color='FFFFFF')
        cell.border = BORDER

    auto_width(ws)

    # — Sheet 2: Chart
    ws2 = wb.create_sheet('Chart')
    chart = BarChart()
    chart.type = 'col'
    chart.title = 'Revenue vs Expenses'
    chart.style = 10
    chart.grouping = 'clustered'
    chart.y_axis.title = 'Amount ($M)'
    chart.x_axis.title = 'Quarter'
    data_ref = Reference(ws, min_col=2, max_col=3, min_row=1, max_row=5)
    cats_ref = Reference(ws, min_col=1, min_row=2, max_row=5)
    chart.add_data(data_ref, titles_from_data=True)
    chart.set_categories(cats_ref)
    chart.shape = 4
    ws2.add_chart(chart, 'B2')

    wb.save('output.xlsx')
    print('✅ output.xlsx created')

build_workbook()
```

### Conditional Formatting
```python
from openpyxl.formatting.rule import ColorScaleRule
# Green-Yellow-Red scale on a column
ws.conditional_formatting.add('E2:E10', ColorScaleRule(
    start_type='min', start_color='F8696B',   # red = low
    mid_type='percentile', mid_value=50, mid_color='FFEB84',  # yellow = mid
    end_type='max', end_color='63BE7B'         # green = high
))
```

### Editing existing Excel files

```python
# Using openpyxl to preserve formulas and formatting
from openpyxl import load_workbook

# Load existing file
wb = load_workbook('existing.xlsx')
sheet = wb.active  # or wb['SheetName'] for specific sheet

# Working with multiple sheets
for sheet_name in wb.sheetnames:
    sheet = wb[sheet_name]
    print(f"Sheet: {sheet_name}")

# Modify cells
sheet['A1'] = 'New Value'
sheet.insert_rows(2)  # Insert row at position 2
sheet.delete_cols(3)  # Delete column 3

# Add new sheet
new_sheet = wb.create_sheet('NewSheet')
new_sheet['A1'] = 'Data'

wb.save('modified.xlsx')
```

## Recalculating formulas

Excel files created or modified by openpyxl contain formulas as strings but not calculated values. Use the provided `scripts/recalc.py` script to recalculate formulas:

```bash
python scripts/recalc.py <excel_file> [timeout_seconds]
```

Example:
```bash
python scripts/recalc.py output.xlsx 30
```

The script:
- Automatically sets up LibreOffice macro on first run
- Recalculates all formulas in all sheets
- Scans ALL cells for Excel errors (#REF!, #DIV/0!, etc.)
- Returns JSON with detailed error locations and counts
- Works on both Linux and macOS

## Formula Verification Checklist

Quick checks to ensure formulas work correctly:

### Essential Verification
- [ ] **Test 2-3 sample references**: Verify they pull correct values before building full model
- [ ] **Column mapping**: Confirm Excel columns match (e.g., column 64 = BL, not BK)
- [ ] **Row offset**: Remember Excel rows are 1-indexed (DataFrame row 5 = Excel row 6)

### Common Pitfalls
- [ ] **NaN handling**: Check for null values with `pd.notna()`
- [ ] **Far-right columns**: FY data often in columns 50+ 
- [ ] **Multiple matches**: Search all occurrences, not just first
- [ ] **Division by zero**: Check denominators before using `/` in formulas (#DIV/0!)
- [ ] **Wrong references**: Verify all cell references point to intended cells (#REF!)
- [ ] **Cross-sheet references**: Use correct format (Sheet1!A1) for linking sheets

### Formula Testing Strategy
- [ ] **Start small**: Test formulas on 2-3 cells before applying broadly
- [ ] **Verify dependencies**: Check all cells referenced in formulas exist
- [ ] **Test edge cases**: Include zero, negative, and very large values

### Interpreting scripts/recalc.py Output
The script returns JSON with error details:
```json
{
  "status": "success",           // or "errors_found"
  "total_errors": 0,              // Total error count
  "total_formulas": 42,           // Number of formulas in file
  "error_summary": {              // Only present if errors found
    "#REF!": {
      "count": 2,
      "locations": ["Sheet1!B5", "Sheet1!C10"]
    }
  }
}
```

## Best Practices

### Library Selection
- **pandas**: Best for data analysis, bulk operations, and simple data export
- **openpyxl**: Best for complex formatting, formulas, and Excel-specific features

### Working with openpyxl
- Cell indices are 1-based (row=1, column=1 refers to cell A1)
- Use `data_only=True` to read calculated values: `load_workbook('file.xlsx', data_only=True)`
- **Warning**: If opened with `data_only=True` and saved, formulas are replaced with values and permanently lost
- For large files: Use `read_only=True` for reading or `write_only=True` for writing
- Formulas are preserved but not evaluated - use scripts/recalc.py to update values

### Working with pandas
- Specify data types to avoid inference issues: `pd.read_excel('file.xlsx', dtype={'id': str})`
- For large files, read specific columns: `pd.read_excel('file.xlsx', usecols=['A', 'C', 'E'])`
- Handle dates properly: `pd.read_excel('file.xlsx', parse_dates=['date_column'])`

## Code Style Guidelines
**IMPORTANT**: When generating Python code for Excel operations:
- Write minimal, concise Python code without unnecessary comments
- Avoid verbose variable names and redundant operations
- Avoid unnecessary print statements

**For Excel files themselves**:
- Add comments to cells with complex formulas or important assumptions
- Document data sources for hardcoded values
- Include notes for key calculations and model sections
