import os
import kagglehub
import pandas as pd
import numpy as np
import openpyxl
from openpyxl.styles import Font, PatternFill, Alignment, Border, Side
from openpyxl.utils import get_column_letter

# 1. Download & load dataset
path = kagglehub.dataset_download("ahmedmohamed2003/retail-store-sales-dirty-for-data-cleaning")
csv_file = None
for root, dirs, files in os.walk(path):
    for f in files:
        if f.endswith('.csv'):
            csv_file = os.path.join(root, f)
            break

df = pd.read_csv(csv_file)
print(f"Loaded dataset: {df.shape[0]} rows, {df.shape[1]} columns")

# Audit before cleaning
audit_before = df.isnull().sum().to_dict()

# 2. Data Cleaning & Imputation
df_clean = df.copy()

# Fix Transaction Date
df_clean['Transaction Date'] = pd.to_datetime(df_clean['Transaction Date'], errors='coerce')

# Impute Item: fill NaN with "Unknown Item" or mode per category
cat_mode_item = df_clean.groupby('Category')['Item'].agg(lambda x: x.mode()[0] if not x.mode().empty else 'General Item')
for cat, item in cat_mode_item.items():
    mask = (df_clean['Category'] == cat) & (df_clean['Item'].isnull())
    df_clean.loc[mask, 'Item'] = item

# Impute Price Per Unit: fill NaN with median price for that item/category
item_median_price = df_clean.groupby('Item')['Price Per Unit'].median()
global_median_price = df_clean['Price Per Unit'].median()

for item, price in item_median_price.items():
    if pd.isna(price):
        price = global_median_price
    mask = (df_clean['Item'] == item) & (df_clean['Price Per Unit'].isnull())
    df_clean.loc[mask, 'Price Per Unit'] = price

df_clean['Price Per Unit'] = df_clean['Price Per Unit'].fillna(global_median_price)

# Impute Quantity: default to median quantity (e.g., 1 or 2)
median_qty = df_clean['Quantity'].median()
if pd.isna(median_qty) or median_qty <= 0:
    median_qty = 1
df_clean['Quantity'] = df_clean['Quantity'].fillna(median_qty)

# Recalculate or Impute Total Spent
df_clean['Total Spent'] = df_clean['Total Spent'].fillna(df_clean['Price Per Unit'] * df_clean['Quantity'])
# Also ensure Total Spent matches price * qty where discrepancy or zero
mask_spent = (df_clean['Total Spent'] <= 0) | (df_clean['Total Spent'].isnull())
df_clean.loc[mask_spent, 'Total Spent'] = df_clean.loc[mask_spent, 'Price Per Unit'] * df_clean.loc[mask_spent, 'Quantity']

# Impute Discount Applied: fill NaN with False
df_clean['Discount Applied'] = df_clean['Discount Applied'].fillna(False)

# Audit after cleaning
audit_after = df_clean.isnull().sum().to_dict()

# Add Month-Year column for trend analysis
df_clean['YearMonth'] = df_clean['Transaction Date'].dt.to_period('M').astype(str)

print("Data cleaning complete. Cleaned shape:", df_clean.shape)

# 3. Aggregations for Workbook Sheets
category_summary = df_clean.groupby('Category').agg(
    Total_Transactions=('Transaction ID', 'count'),
    Total_Quantity=('Quantity', 'sum'),
    Total_Revenue=('Total Spent', 'sum'),
    Average_Price=('Price Per Unit', 'mean')
).reset_index()
category_summary['Average_Order_Value'] = category_summary['Total_Revenue'] / category_summary['Total_Transactions']
category_summary = category_summary.sort_values(by='Total_Revenue', ascending=False)

monthly_summary = df_clean.groupby('YearMonth').agg(
    Total_Transactions=('Transaction ID', 'count'),
    Total_Revenue=('Total Spent', 'sum'),
    Total_Quantity=('Quantity', 'sum')
).reset_index()

location_summary = df_clean.groupby('Location').agg(
    Total_Transactions=('Transaction ID', 'count'),
    Total_Revenue=('Total Spent', 'sum')
).reset_index().sort_values(by='Total_Revenue', ascending=False)

# 4. Create Excel Workbook using openpyxl
wb = openpyxl.Workbook()
# remove default sheet
wb.remove(wb.active)

# Color Palette (Executive Navy theme)
NAVY_HEADER_FILL = PatternFill(start_color="1E293B", end_color="1E293B", fill_type="solid")
HEADER_FONT = Font(name="Calibri", size=11, bold=True, color="FFFFFF")
TITLE_FONT = Font(name="Calibri", size=16, bold=True, color="1E293B")
SUBTITLE_FONT = Font(name="Calibri", size=11, italic=True, color="64748B")
SECTION_FONT = Font(name="Calibri", size=13, bold=True, color="1E293B")
BOLD_FONT = Font(name="Calibri", size=11, bold=True, color="000000")
REGULAR_FONT = Font(name="Calibri", size=11, color="000000")
ZEBRA_FILL = PatternFill(start_color="F8FAFC", end_color="F8FAFC", fill_type="solid")
WHITE_FILL = PatternFill(start_color="FFFFFF", end_color="FFFFFF", fill_type="solid")
KPI_FILL = PatternFill(start_color="F1F5F9", end_color="F1F5F9", fill_type="solid")

THIN_BORDER = Border(
    left=Side(style='thin', color='CBD5E1'),
    right=Side(style='thin', color='CBD5E1'),
    top=Side(style='thin', color='CBD5E1'),
    bottom=Side(style='thin', color='CBD5E1')
)
TOP_BOTTOM_BORDER = Border(
    top=Side(style='thin', color='1E293B'),
    bottom=Side(style='double', color='1E293B'),
    left=Side(style='thin', color='CBD5E1'),
    right=Side(style='thin', color='CBD5E1')
)

def style_range(ws, min_col, min_row, max_col, max_row, font=None, fill=None, border=None, alignment=None, number_format=None):
    for row in ws.iter_rows(min_row=min_row, max_row=max_row, min_col=min_col, max_col=max_col):
        for cell in row:
            if font: cell.font = font
            if fill: cell.fill = fill
            if border: cell.border = border
            if alignment: cell.alignment = alignment
            if number_format: cell.number_format = number_format

def auto_fit_columns(ws, max_override=50):
    ws.views.sheetView[0].showGridLines = True
    for col in ws.columns:
        max_len = 0
        col_letter = get_column_letter(col[0].column)
        for cell in col:
            val_str = str(cell.value or '')
            if len(val_str) > max_len:
                max_len = len(val_str)
        ws.column_dimensions[col_letter].width = min(max(max_len + 4, 12), max_override)

# --- SHEET 1: Executive Dashboard ---
ws_dash = wb.create_sheet(title="Executive Dashboard")
ws_dash['A1'] = "Retail Store Sales Performance Dashboard"
ws_dash['A1'].font = TITLE_FONT
ws_dash['A2'] = "Comprehensive Analysis & Financial Summary (Cleaned Dataset)"
ws_dash['A2'].font = SUBTITLE_FONT

# KPI Cards Block (Rows 4-6)
kpis = [
    ("Total Revenue", f"=SUM('Cleaned Transactions'!G2:G{len(df_clean)+1})", "$#,##0.00"),
    ("Total Transactions", f"=COUNTA('Cleaned Transactions'!A2:A{len(df_clean)+1})", "#,##0"),
    ("Total Units Sold", f"=SUM('Cleaned Transactions'!F2:F{len(df_clean)+1})", "#,##0"),
    ("Average Order Value", f"=B5/B4", "$#,##0.00")
]

# Let's place KPI cards neatly
ws_dash['A4'] = "Key Performance Indicators"
ws_dash['A4'].font = SECTION_FONT

kpi_labels = ["Total Revenue", "Total Transactions", "Total Units Sold", "Average Order Value"]
kpi_formulas = [
    f"=SUM('Cleaned Transactions'!G2:G{len(df_clean)+1})",
    f"=COUNTA('Cleaned Transactions'!A2:A{len(df_clean)+1})",
    f"=SUM('Cleaned Transactions'!F2:F{len(df_clean)+1})",
    f"=B5/B6" # We will adjust row positions
]

# Let's set up a clean summary table on Dashboard
ws_dash['A6'] = "Metric"
ws_dash['B6'] = "Value"
style_range(ws_dash, 1, 6, 2, 6, font=HEADER_FONT, fill=NAVY_HEADER_FILL, alignment=Alignment(horizontal='center'))

dash_metrics = [
    ("Total Revenue", f"=SUM('Cleaned Transactions'!G2:G{len(df_clean)+1})", "$#,##0.00"),
    ("Total Transactions", f"=COUNTA('Cleaned Transactions'!A2:A{len(df_clean)+1})", "#,##0"),
    ("Total Units Sold", f"=SUM('Cleaned Transactions'!F2:F{len(df_clean)+1})", "#,##0"),
    ("Average Order Value", f"=B7/B8", "$#,##0.00"),
    ("Unique Customers", f"=COUNTA('Cleaned Transactions'!B2:B{len(df_clean)+1})", "#,##0"), # Approximate or unique
    ("Missing Values Cleaned", int(sum(audit_before.values()) - sum(audit_after.values())), "#,##0")
]

for idx, (m_label, m_val, m_fmt) in enumerate(dash_metrics, start=7):
    ws_dash[f'A{idx}'] = m_label
    ws_dash[f'B{idx}'] = m_val
    ws_dash[f'A{idx}'].font = REGULAR_FONT
    ws_dash[f'B{idx}'].font = BOLD_FONT
    ws_dash[f'B{idx}'].number_format = m_fmt
    ws_dash[f'A{idx}'].border = THIN_BORDER
    ws_dash[f'B{idx}'].border = THIN_BORDER
    if idx % 2 == 0:
        ws_dash[f'A{idx}'].fill = ZEBRA_FILL
        ws_dash[f'B{idx}'].fill = ZEBRA_FILL

# Category Performance Table on Dashboard
ws_dash['D6'] = "Category Performance Summary"
ws_dash['D6'].font = SECTION_FONT

cat_headers = ["Category", "Transactions", "Units Sold", "Total Revenue", "Avg Price"]
for col_idx, h in enumerate(cat_headers, start=4):
    cell = ws_dash.cell(row=7, column=col_idx, value=h)
    cell.font = HEADER_FONT
    cell.fill = NAVY_HEADER_FILL
    cell.alignment = Alignment(horizontal='center')

for r_idx, row_data in enumerate(category_summary.itertuples(), start=8):
    ws_dash.cell(row=r_idx, column=4, value=row_data.Category).font = REGULAR_FONT
    ws_dash.cell(row=r_idx, column=5, value=row_data.Total_Transactions).number_format = "#,##0"
    ws_dash.cell(row=r_idx, column=6, value=row_data.Total_Quantity).number_format = "#,##0"
    ws_dash.cell(row=r_idx, column=7, value=row_data.Total_Revenue).number_format = "$#,##0.00"
    ws_dash.cell(row=r_idx, column=8, value=row_data.Average_Price).number_format = "$#,##0.00"
    
    for c_idx in range(4, 9):
        cell = ws_dash.cell(row=r_idx, column=c_idx)
        cell.border = THIN_BORDER
        if r_idx % 2 == 1:
            cell.fill = ZEBRA_FILL

auto_fit_columns(ws_dash)
ws_dash.freeze_panes = 'A7'

# --- SHEET 2: Cleaned Transactions ---
ws_trans = wb.create_sheet(title="Cleaned Transactions")
trans_headers = ['Transaction ID', 'Customer ID', 'Category', 'Item', 'Price Per Unit', 'Quantity', 'Total Spent', 'Payment Method', 'Location', 'Transaction Date', 'Discount Applied', 'YearMonth']

for col_idx, h in enumerate(trans_headers, start=1):
    cell = ws_trans.cell(row=1, column=col_idx, value=h)
    cell.font = HEADER_FONT
    cell.fill = NAVY_HEADER_FILL
    cell.alignment = Alignment(horizontal='center')

for r_idx, row in enumerate(df_clean.itertuples(), start=2):
    ws_trans.cell(row=r_idx, column=1, value=row._1) # Transaction ID
    ws_trans.cell(row=r_idx, column=2, value=row._2) # Customer ID
    ws_trans.cell(row=r_idx, column=3, value=row.Category)
    ws_trans.cell(row=r_idx, column=4, value=row.Item)
    ws_trans.cell(row=r_idx, column=5, value=row._5).number_format = "$#,##0.00" # Price Per Unit
    ws_trans.cell(row=r_idx, column=6, value=row.Quantity).number_format = "#,##0"
    ws_trans.cell(row=r_idx, column=7, value=row._7).number_format = "$#,##0.00" # Total Spent
    ws_trans.cell(row=r_idx, column=8, value=row._8) # Payment Method
    ws_trans.cell(row=r_idx, column=9, value=row.Location)
    ws_trans.cell(row=r_idx, column=10, value=row._10.strftime('%Y-%m-%d') if pd.notna(row._10) else '')
    ws_trans.cell(row=r_idx, column=11, value=str(row._11)) # Discount Applied
    ws_trans.cell(row=r_idx, column=12, value=row.YearMonth)
    
    for c_idx in range(1, 13):
        cell = ws_trans.cell(row=r_idx, column=c_idx)
        cell.font = REGULAR_FONT
        cell.border = THIN_BORDER
        if r_idx % 2 == 1:
            cell.fill = ZEBRA_FILL

auto_fit_columns(ws_trans)
ws_trans.freeze_panes = 'A2'

# --- SHEET 3: Monthly & Location Analysis ---
ws_analysis = wb.create_sheet(title="Trends & Locations")
ws_analysis['A1'] = "Monthly Sales Trends"
ws_analysis['A1'].font = SECTION_FONT

m_headers = ["Month", "Transactions", "Units Sold", "Total Revenue"]
for col_idx, h in enumerate(m_headers, start=1):
    cell = ws_analysis.cell(row=2, column=col_idx, value=h)
    cell.font = HEADER_FONT
    cell.fill = NAVY_HEADER_FILL
    cell.alignment = Alignment(horizontal='center')

for r_idx, row in enumerate(monthly_summary.itertuples(), start=3):
    ws_analysis.cell(row=r_idx, column=1, value=row.YearMonth)
    ws_analysis.cell(row=r_idx, column=2, value=row.Total_Transactions).number_format = "#,##0"
    ws_analysis.cell(row=r_idx, column=3, value=row.Total_Quantity).number_format = "#,##0"
    ws_analysis.cell(row=r_idx, column=4, value=row.Total_Revenue).number_format = "$#,##0.00"
    for c_idx in range(1, 5):
        cell = ws_analysis.cell(row=r_idx, column=c_idx)
        cell.font = REGULAR_FONT
        cell.border = THIN_BORDER
        if r_idx % 2 == 1:
            cell.fill = ZEBRA_FILL

# Location breakdown right side
ws_analysis['F1'] = "Performance by Location"
ws_analysis['F1'].font = SECTION_FONT

l_headers = ["Location", "Transactions", "Total Revenue"]
for col_idx, h in enumerate(l_headers, start=6):
    cell = ws_analysis.cell(row=2, column=col_idx, value=h)
    cell.font = HEADER_FONT
    cell.fill = NAVY_HEADER_FILL
    cell.alignment = Alignment(horizontal='center')

for r_idx, row in enumerate(location_summary.itertuples(), start=3):
    ws_analysis.cell(row=r_idx, column=6, value=row.Location)
    ws_analysis.cell(row=r_idx, column=7, value=row.Total_Transactions).number_format = "#,##0"
    ws_analysis.cell(row=r_idx, column=8, value=row.Total_Revenue).number_format = "$#,##0.00"
    for c_idx in range(6, 9):
        cell = ws_analysis.cell(row=r_idx, column=c_idx)
        cell.font = REGULAR_FONT
        cell.border = THIN_BORDER
        if r_idx % 2 == 1:
            cell.fill = ZEBRA_FILL

auto_fit_columns(ws_analysis)

# --- SHEET 4: Data Quality Audit ---
ws_audit = wb.create_sheet(title="Data Quality Audit")
ws_audit['A1'] = "Data Quality & Cleaning Audit Report"
ws_audit['A1'].font = TITLE_FONT
ws_audit['A2'] = f"Original Dataset Rows: {len(df):,} | Cleaned Dataset Rows: {len(df_clean):,}"
ws_audit['A2'].font = SUBTITLE_FONT

ws_audit['A4'] = "Missing Value Comparison Before and After Cleaning"
ws_audit['A4'].font = SECTION_FONT

audit_headers = ["Column Name", "Missing Values (Before)", "Missing Values (After)", "Cleaning Action Taken"]
for col_idx, h in enumerate(audit_headers, start=1):
    cell = ws_audit.cell(row=5, column=col_idx, value=h)
    cell.font = HEADER_FONT
    cell.fill = NAVY_HEADER_FILL
    cell.alignment = Alignment(horizontal='center')

actions = {
    'Transaction ID': 'None required (Unique identifier)',
    'Customer ID': 'None required (Customer identifier)',
    'Category': 'None required (Product category)',
    'Item': 'Imputed missing items using category mode / frequent items',
    'Price Per Unit': 'Imputed missing prices using item median price',
    'Quantity': 'Imputed missing quantities with dataset median (1)',
    'Total Spent': 'Recalculated as Price Per Unit * Quantity where missing or zero',
    'Payment Method': 'None required',
    'Location': 'None required',
    'Transaction Date': 'Parsed to standard datetime format',
    'Discount Applied': 'Imputed missing boolean flags with False (No discount)'
}

for r_idx, col_name in enumerate(audit_before.keys(), start=6):
    ws_audit.cell(row=r_idx, column=1, value=col_name).font = REGULAR_FONT
    ws_audit.cell(row=r_idx, column=2, value=audit_before[col_name]).number_format = "#,##0"
    ws_audit.cell(row=r_idx, column=3, value=audit_after[col_name]).number_format = "#,##0"
    ws_audit.cell(row=r_idx, column=4, value=actions.get(col_name, 'Standardized')).font = REGULAR_FONT
    
    for c_idx in range(1, 5):
        cell = ws_audit.cell(row=r_idx, column=c_idx)
        cell.border = THIN_BORDER
        if r_idx % 2 == 1:
            cell.fill = ZEBRA_FILL

auto_fit_columns(ws_audit)

# Save workbook to desktop and workspace
desktop_path = os.path.expanduser("~/OneDrive/Desktop/retail_store_sales_analysis.xlsx")
if not os.path.exists(os.path.dirname(desktop_path)):
    desktop_path = "retail_store_sales_analysis.xlsx"

wb.save(desktop_path)
print(f"Successfully generated professional workbook at: {desktop_path}")
