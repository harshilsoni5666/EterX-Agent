import os
import pandas as pd
import matplotlib.pyplot as plt
import seaborn as sns

# Set style for professional presentation
plt.style.use('seaborn-v0_8-whitegrid' if 'seaborn-v0_8-whitegrid' in plt.style.available else 'default')
plt.rcParams['font.sans-serif'] = 'Segoe UI'
plt.rcParams['axes.edgecolor'] = '#CBD5E1'
plt.rcParams['axes.linewidth'] = 1.0

# Define paths
real_desktop_1 = r"C:\Users\AAYUSHI\OneDrive\Desktop"
real_desktop_2 = r"C:\Users\AAYUSHI\Desktop"

if os.path.exists(real_desktop_1):
    desktop_path = real_desktop_1
elif os.path.exists(real_desktop_2):
    desktop_path = real_desktop_2
else:
    desktop_path = os.path.join(os.path.expanduser('~'), 'Desktop')

charts_dir = os.path.join(desktop_path, 'Retail_Store_Sales_Professional_Charts')
os.makedirs(charts_dir, exist_ok=True)

print(f"Target charts folder: {charts_dir}")

# Load dataset
df = pd.read_excel('retail_store_sales_analysis.xlsx', sheet_name='Cleaned Transactions')
print(f"Loaded dataset with {len(df):,} rows. Columns: {list(df.columns)}")

primary_color = '#1E293B'
accent_color = '#0EA5E9'
palette = ['#1E293B', '#0EA5E9', '#10B981', '#F59E0B', '#EF4444', '#8B5CF6', '#EC4899', '#64748B']

# 1. Revenue by Product Category
if 'Category' in df.columns and 'Total Spent' in df.columns:
    plt.figure(figsize=(10, 6), dpi=300)
    cat_sales = df.groupby('Category')['Total Spent'].sum().sort_values(ascending=False).reset_index()
    sns.barplot(data=cat_sales, x='Total Spent', y='Category', palette='Blues_r')
    plt.title('Total Revenue by Product Category', fontsize=16, fontweight='bold', pad=15, color=primary_color)
    plt.xlabel('Total Revenue ($)', fontsize=12, fontweight='bold', color=primary_color)
    plt.ylabel('Product Category', fontsize=12, fontweight='bold', color=primary_color)
    plt.tight_layout()
    chart_path = os.path.join(charts_dir, '1_Revenue_by_Product_Category.png')
    plt.savefig(chart_path)
    plt.close()
    print(f"Saved: {chart_path}")

# 2. Monthly Sales Trend
if 'YearMonth' in df.columns and 'Total Spent' in df.columns:
    plt.figure(figsize=(12, 6), dpi=300)
    monthly_sales = df.groupby('YearMonth')['Total Spent'].sum().reset_index()
    sns.lineplot(data=monthly_sales, x='YearMonth', y='Total Spent', marker='o', color=accent_color, linewidth=3, markersize=8)
    plt.title('Monthly Sales Performance Trend', fontsize=16, fontweight='bold', pad=15, color=primary_color)
    plt.xlabel('Year-Month', fontsize=12, fontweight='bold', color=primary_color)
    plt.ylabel('Total Revenue ($)', fontsize=12, fontweight='bold', color=primary_color)
    plt.xticks(rotation=45)
    plt.tight_layout()
    chart_path = os.path.join(charts_dir, '2_Monthly_Sales_Trend.png')
    plt.savefig(chart_path)
    plt.close()
    print(f"Saved: {chart_path}")

# 3. Revenue Share by Store Location
if 'Location' in df.columns and 'Total Spent' in df.columns:
    plt.figure(figsize=(8, 8), dpi=300)
    loc_sales = df.groupby('Location')['Total Spent'].sum()
    plt.pie(loc_sales, labels=loc_sales.index, autopct='%1.1f%%', startangle=140, colors=palette[:len(loc_sales)],
            wedgeprops={'edgecolor': 'white', 'linewidth': 2}, textprops={'fontsize': 11, 'fontweight': 'bold'})
    plt.title('Revenue Share by Store Location', fontsize=16, fontweight='bold', pad=15, color=primary_color)
    plt.tight_layout()
    chart_path = os.path.join(charts_dir, '3_Revenue_Share_by_Location.png')
    plt.savefig(chart_path)
    plt.close()
    print(f"Saved: {chart_path}")

# 4. Quantity vs Total Spent Distribution
if 'Quantity' in df.columns and 'Total Spent' in df.columns:
    plt.figure(figsize=(10, 6), dpi=300)
    sns.boxplot(data=df, x='Quantity', y='Total Spent', palette='Set2')
    plt.title('Transaction Value Distribution by Quantity Sold', fontsize=16, fontweight='bold', pad=15, color=primary_color)
    plt.xlabel('Quantity per Transaction', fontsize=12, fontweight='bold', color=primary_color)
    plt.ylabel('Total Spent ($)', fontsize=12, fontweight='bold', color=primary_color)
    plt.tight_layout()
    chart_path = os.path.join(charts_dir, '4_Transaction_Value_by_Quantity.png')
    plt.savefig(chart_path)
    plt.close()
    print(f"Saved: {chart_path}")

# 5. Discount Impact Analysis
if 'Discount Applied' in df.columns and 'Total Spent' in df.columns:
    plt.figure(figsize=(8, 6), dpi=300)
    sns.barplot(data=df, x='Discount Applied', y='Total Spent', estimator=lambda x: sum(x)/len(x), palette=['#64748B', '#10B981'])
    plt.title('Average Transaction Value: Discount vs No Discount', fontsize=16, fontweight='bold', pad=15, color=primary_color)
    plt.xlabel('Discount Applied (True / False)', fontsize=12, fontweight='bold', color=primary_color)
    plt.ylabel('Average Order Value ($)', fontsize=12, fontweight='bold', color=primary_color)
    plt.tight_layout()
    chart_path = os.path.join(charts_dir, '5_Discount_Impact_Analysis.png')
    plt.savefig(chart_path)
    plt.close()
    print(f"Saved: {chart_path}")

report_content = """# Retail Store Sales - Professional Charts & Analytics Report

Generated for Executive Presentation.

## Overview of Visualizations
1. **1_Revenue_by_Product_Category.png**: Breakdown of total revenue generated across all 8 product categories, highlighting top-performing merchandise lines.
2. **2_Monthly_Sales_Trend.png**: Chronological trajectory of monthly revenue and sales velocity across the retail stores.
3. **3_Revenue_Share_by_Location.png**: Proportional distribution of sales revenue across physical and regional store locations.
4. **4_Transaction_Value_by_Quantity.png**: Distribution of transaction totals correlated with units purchased per basket.
5. **5_Discount_Impact_Analysis.png**: Comparative analysis of average transaction values with and without promotional discounts applied.

---
*All charts are rendered at high-resolution (300 DPI) using professional color palettes designed for stakeholder meetings and strategic reporting.*
"""

readme_path = os.path.join(charts_dir, 'README.md')
with open(readme_path, 'w', encoding='utf-8') as f:
    f.write(report_content)

print(f"Saved README: {readme_path}")
print("All professional charts generated and saved successfully!")
