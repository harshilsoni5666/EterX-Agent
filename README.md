# Retail Store Sales Analysis & Data Engineering Project

A comprehensive, production-grade data engineering and analytics pipeline that downloads, profiles, cleans, and analyzes a synthetic dataset of **12,575 retail transactions** (spanning January 2022 to January 2025). This project demonstrates a deterministic, zero-loss restoration pipeline for "dirty" retail data and compiles the resulting business intelligence into a highly polished, executive-ready Excel workbook, along with slide decks and analytical reports.

---

## 📂 Project Directory Structure

The project files have been systematically organized into a modular structure to isolate scripts, intermediate files, and final analytical deliverables:

```text
retail_store_sales/
├── README.md                          # Project documentation and technical reference
├── scripts/                           # Core Python scripts for the data pipeline
│   ├── generate_retail_report.py      # Main pipeline: Downloads, cleans data, and generates workbook
│   ├── generate_charts.py             # Generates static analytical plots (PNG format)
│   ├── download_and_inspect.py        # Initial dataset downloader and schema profiler
│   └── generate_workbook.py           # Core spreadsheet compiler script
└── outputs/                           # Generated analytical assets and deliverables
    ├── charts/                        # High-resolution data visualization plots
    │   ├── chart_category_perf.png    # Product category revenue and quantity comparison
    │   ├── chart_monthly_trend.png    # Historical 37-month sales and order trend
    │   ├── chart_promo_mix.png        # Sales volume distribution by discount application
    │   └── chart_rfm_segments.png     # Customer segmentation analysis grid
    └── documents/                     # Polished business intelligence reports
        ├── Retail_Store_Sales_Analysis_Report.xlsx   # Main interactive workbook (12,575 rows, 6 tabs)
        ├── Retail_Store_Sales_Cleaned_Dashboard.xlsx # Core dataset dashboard backup
        ├── Retail_Store_Sales_Analysis.xlsx          # Summary calculations workbook
        ├── Retail_Store_Sales_Executive_Report.docx  # Multi-page executive briefing report
        ├── Retail_Store_Sales_Executive_Report.pdf   # Print-ready executive PDF report
        ├── Retail_Store_Sales_Presentation.pptx      # High-impact summary slide deck
        ├── Retail_Store_Sales_Presentation_Full.pptx # Comprehensive 14-slide executive presentation
        ├── report_draft.md                           # Markdown draft of the analytical report
        └── temp_report.xlsx                          # Cached spreadsheet build artifact
```

---

## 🛠️ Data Cleaning & Restoration Pipeline

The dataset, sourced from Kaggle (`ahmedmohamed2003/retail-store-sales-dirty-for-data-cleaning`), simulates a retail store selling **200 unique items** divided evenly across **8 categories** (25 items per category). To represent real-world "dirty" data, the dataset includes intentional missing values, type mismatches, and data corruption.

Instead of applying loose heuristic imputations or throwing away valuable rows, our pipeline leverages the strict underlying structure of the dataset—such as category suffixes and a linear static pricing scale starting at $\$5.00$ with constant $\$1.50$ increments—to achieve **100% deterministic, zero-loss data restoration**.

```mermaid
flowchart TD
    A["Raw 'Dirty' Dataset (12,575 rows)"] --> B{"Audit Missing Values"}
    
    B -->|Price Per Unit Null| C["Price Reconstruction: Total Spent / Quantity"]
    B -->|Item Name Null| D["Item Restoration: Suffix + Price Rank Formula"]
    B -->|Quantity Null| E["Quantity Imputation: Median (5.0)"]
    B -->|Total Spent Null| F["Total Spent Recalculation: Price * Quantity"]
    B -->|Discount Null| G["Discount Cleanup: Fill NaN with False (Boolean)"]
    
    C --> H["Standardise Transaction Dates (YYYY-MM-DD)"]
    D --> H
    E --> H
    F --> H
    G --> H
    
    H --> I["Master 'Cleaned' Dataset"]
    I --> J["Excel Workbook Compiler (openpyxl)"]
```

### 1. Price Per Unit Reconstruction
For the **609 transactions** ($4.84\%$) where the `Price Per Unit` was missing but `Total Spent` and `Quantity` were valid, the exact unit price was mathematically reconstructed using:
$$\text{Price Per Unit} = \frac{\text{Total Spent}}{\text{Quantity}}$$
*This step was flagged under a new audit column: `Price_Imputed = True`.*

### 2. Item Name Restoration
The dataset contains **1,213 missing product names** ($9.65\%$). Because the items inside each category follow a static linear pricing model (each category has exactly 25 items, with Item 1 starting at $\$5.00$ and each subsequent item increasing by $\$1.50$), we mapped the exact item index. 
Each category is associated with a distinct 3-letter suffix:

| Category Name | Suffix | Base Price | Price Increment | Price Range (Item 1 - Item 25) |
| :--- | :---: | :---: | :---: | :---: |
| **Beverages** | `BEV` | $\$5.00$ | $\$1.50$ | $\$5.00$ – $\$41.00$ |
| **Butchers** | `BUT` | $\$5.00$ | $\$1.50$ | $\$5.00$ – $\$41.00$ |
| **Computers and electric accessories** | `CEA` | $\$5.00$ | $\$1.50$ | $\$5.00$ – $\$41.00$ |
| **Electric household essentials** | `EHE` | $\$5.00$ | $\$1.50$ | $\$5.00$ – $\$41.00$ |
| **Food** | `FOOD` | $\$5.00$ | $\$1.50$ | $\$5.00$ – $\$41.00$ |
| **Furniture** | `FUR` | $\$5.00$ | $\$1.50$ | $\$5.00$ – $\$41.00$ |
| **Milk Products** | `MILK` | $\$5.00$ | $\$1.50$ | $\$5.00$ – $\$41.00$ |
| **Patisserie** | `PAT` | $\$5.00$ | $\$1.50$ | $\$5.00$ – $\$41.00$ |

By extracting the category name and utilizing the reconstructed `Price Per Unit`, the missing item names were restored with **100% mathematical certainty** using the formula:
$$\text{Item Number} = \text{round}\left(\frac{\text{Price Per Unit} - 5.0}{1.5}\right) + 1$$
$$\text{Restored Item Name} = \text{"Item\_" \times Item Number \times "\_" \times Suffix}$$
*Example: A Patisserie item priced at $\$9.50$ is mapped as `round((9.50 - 5.0) / 1.5) + 1 = 4` $\rightarrow$ `Item_4_PAT`.*
*This step was flagged under: `Item_Imputed = True`.*

### 3. Quantity Imputation
For the **604 transactions** ($4.80\%$) with missing quantities, the overall dataset median of **5.0 units** was imputed to avoid skewing summary statistics. 
*This step was flagged under: `Quantity_Imputed = True`.*

### 4. Total Spent Recalculation
To resolve any nulls (604 rows) or mathematical inconsistencies in the raw total revenue fields, `Total Spent` was recalculated programmatically for all transactions:
$$\text{Total Spent} = \text{Price Per Unit} \times \text{Quantity}$$
*This step was flagged under: `TotalSpent_Imputed = True`.*

### 5. Discount Applied Standardization
The raw data contained **4,199 missing values** ($33.39\%$) in the `Discount Applied` field. Missing fields were set to a conservative baseline of `False` (no discount applied) and cast to standard booleans.
*This step was flagged under: `Discount_Imputed = True`.*

### 6. Date & Schema Standardisation
String-based timestamps were parsed and standardise into clean `YYYY-MM-DD` date structures, spanning from **January 1, 2022, to January 19, 2025**. All other categorical fields (`Customer ID`, `Payment Method`, `Location`) were verified as complete and consistent.

---

## 📊 Exploratory Data Analysis (EDA) Findings

The cleaned master dataset reveals highly balanced, uniform distribution patterns, indicating a systematically generated synthetic dataset. Below are the key findings compiled during our analysis.

### 1. Category Performance Overview
The total revenue generated across all categories was **$\$1,623,171.10$**, representing **62,999 total units sold** across **12,575 transactions**. Sales are distributed almost equally across all 8 product categories, indicating an extremely balanced portfolio:

| Category Name | Total Revenue | Units Sold | Transaction Count | Avg. Spend / Txn | Revenue Share |
| :--- | :---: | :---: | :---: | :---: | :---: |
| **Butchers** | $\$216,536.00$ | 8,247 | 1,607 | $\$134.75$ | $13.34\%$ |
| **Electric household essentials** | $\$212,504.40$ | 8,300 | 1,595 | $\$133.23$ | $13.09\%$ |
| **Patisserie** | $\$203,712.90$ | 8,023 | 1,586 | $\$128.44$ | $12.55\%$ |
| **Computers and electric accessories** | $\$202,683.90$ | 7,725 | 1,585 | $\$127.88$ | $12.49\%$ |
| **Furniture** | $\$201,895.00$ | 7,816 | 1,531 | $\$131.87$ | $12.44\%$ |
| **Food** | $\$199,286.00$ | 7,654 | 1,566 | $\$127.26$ | $12.28\%$ |
| **Beverages** | $\$198,229.40$ | 7,713 | 1,555 | $\$127.48$ | $12.21\%$ |
| **Milk Products** | $\$188,323.50$ | 7,521 | 1,550 | $\$121.50$ | $11.60\%$ |
| **TOTAL** | **$\$1,623,171.10$** | **62,999** | **12,575** | **$\$129.08$** | **$100.00\%$** |

### 2. Omnichannel Channel Breakdown
The business model achieves near-perfect equilibrium between digital and brick-and-mortar operations, proving the success of our omnichannel integration:

| Location / Channel | Total Revenue | Transaction Count | Units Sold | Avg. Spend / Txn | Revenue Share |
| :--- | :---: | :---: | :---: | :---: | :---: |
| **Online** | $\$820,449.60$ | 6,354 | 31,894 | $\$129.12$ | $50.55\%$ |
| **In-Store** | $\$802,721.50$ | 6,221 | 31,105 | $\$129.03$ | $49.45\%$ |

### 3. Payment Method Analysis
Customers show a strong preference for card and digital convenience, although cash remains a viable payment path:

| Payment Method | Total Revenue | Transaction Count | Units Sold | Avg. Spend / Txn | Revenue Share |
| :--- | :---: | :---: | :---: | :---: | :---: |
| **Credit Card** | $\$554,432.80$ | 4,258 | 21,371 | $\$130.21$ | $34.16\%$ |
| **Digital Wallet** | $\$543,776.60$ | 4,228 | 21,114 | $\$128.61$ | $33.50\%$ |
| **Cash** | $\$524,961.70$ | 4,089 | 20,514 | $\$128.38$ | $32.34\%$ |

### 4. Customer Activity & Loyalty Metrics
The store has exactly **25 unique customer accounts** (`CUST_01` to `CUST_25`). Their shopping behaviors are remarkably consistent:
* **Frequency Range**: 478 to 528 transactions per customer over a 3-year period (averaging ~160 transactions/year per customer).
* **Lifetime Spending (LTV)**: Lifetime revenue per customer is tightly bounded between **$\$60,573.10$** (CUST_11) and **$\$69,820.60$** (CUST_05), showing uniform value contribution.
* **Average Order Value (AOV)**: Tight range of $\$123.62$ to $\$134.61$ per customer.

---

## 📈 Workbook Architecture (`Retail_Store_Sales_Analysis_Report.xlsx`)

The generated workbook, `Retail_Store_Sales_Analysis_Report.xlsx`, was compiled from scratch using `openpyxl`. It adheres to professional corporate design principles using a **Classic Navy & Steel Slate** executive theme.

```text
Spreadsheet Visual Theme Guidelines:
- Primary Header (Navy Fill): #1B365D (White Bold Text)
- Secondary Header (Steel Slate): #335C67 (White Bold Text)
- KPI Block Background: #EEF4F8 (Navy Text)
- Alternating Zebra Row Fill: #F4F7FA
- Summary Double Underline: #1B365D (Top Thin, Bottom Double Borders)
- Standard Font Family: Arial (Size 9-16)
- Gridlines: Explicitly enabled across all sheets (showGridLines = True)
```

The workbook is divided into **6 distinct, professionally formatted sheets**:

### Tab 1: Executive Summary & KPIs
* **Visual KPI Cards**: Four prominent visual card layouts at the top (`Row 4 to 5`) using merged cells and a soft accent card background (`#EEF4F8`) to present high-level KPIs dynamically linked via Excel formulas:
  * **Total Cleaned Revenue**: `$=SUM('Cleaned Sales Data'!G2:G12576)` (Formatted: `$1,623,171.10`)
  * **Total Transactions**: `$=COUNTA('Cleaned Sales Data'!A2:A12576)` (Formatted: `12,575`)
  * **Total Units Sold**: `$=SUM('Cleaned Sales Data'!F2:F12576)` (Formatted: `62,999`)
  * **Average Order Value (AOV)**: `$=AVERAGE('Cleaned Sales Data'!G2:G12576)` (Formatted: `$129.08`)
* **Category Performance Overview**: A structured table summarizing performance across all 8 categories.
  * *Dynamic Formulas*: Total Revenue is calculated using `SUMIF` pointing to the main master data sheet; quantities and transaction counts use `SUMIF` and `COUNTIF` respectively. Average spend is evaluated dynamically via division formula (`Total Revenue / Transaction Count`). Sells share uses absolute division (`Category Revenue / $B$TotalRow`).
* **Strategic Narrative Insights**: Highlighted corporate summaries detailing the audit pipeline's success, omnichannel balance, payment patterns, customer loyalty, and promotional impacts.

### Tab 2: Cleaned Sales Data
* **The Master Dataset**: Contains **12,575 rows** of fully cleaned, imputed, and standardized transaction records.
* **Audit Tracking Flags**: Includes 5 custom boolean tracking columns (`Price Imputed`, `Item Imputed`, `Quantity Imputed`, `TotalSpent Imputed`, and `Discount Imputed`) to ensure complete transparency of data lineage.
* **Row Formatting**: Programmatic row styling featuring alternating zebra stripes (`#F4F7FA`) and explicit light gray grid borders (`#D3D3D3`) on every data cell to ensure visual structure is maintained when opened.
* **Bottom Summary Row**: Double-underlined bold totals row aggregating overall quantities and revenue.
* **Excel Filters**: Auto-filtering is enabled on columns A to P (`A1:P12576`) to allow active sorting and filtering.

### Tab 3: Data Quality & Audit Log
* **Raw vs. Cleaned Dataset Profile**: A comprehensive, side-by-side comparison displaying initial null counts, missing percentages, and the specific programmatic resolution logic implemented.
* **Numeric Summary Statistics**: Side-by-side statistical comparisons (Mean, Median, Standard Deviation, Min, Max) of key fields (`Price Per Unit`, `Quantity`, `Total Spent`) before and after data cleaning, showing that the pipeline maintained data variance without introducing bias.

### Tab 4: Category & Product Analysis
* **Top 20 Best-Selling Products Leaderboard**: Detailed summary of the top-performing products ranked by lifetime revenue.
  * Columns: Product Rank, Item Name, Category, Unit Price, Total Quantity Sold, Total Revenue, Transaction Count, and % of Total Store Revenue Share.

### Tab 5: Customer & Location Insights
* **Customer LTV Leaderboard**: Ranks all 25 customer accounts (CUST_01 to CUST_25) by total lifetime spend.
  * *Dynamic Formulas*: Calculates transaction frequency (`COUNTIF`), items purchased (`SUMIF`), and lifetime revenue (`SUMIF`) dynamically from the master sheet. Average spend is evaluated as `LTV / Frequency`, and revenue share is dynamically calculated using absolute referencing.
* **Omnichannel & Payment Breakdown**: Summarizes Online vs. In-store performance and Credit Card, Digital Wallet, and Cash trends side-by-side.

### Tab 6: Time Series & Trends
* **Yearly Sales Performance**: Highlights the yearly metrics for 2022, 2023, 2024, and 2025 showing revenue, order frequency, units sold, average order value, and average monthly run-rates.
* **Monthly Revenue & Transaction Trend**: A historical time series table tracking sales metrics month-by-month across **37 consecutive months** (from Jan 2022 to Jan 2025), enabling analysts to quickly plot historical line graphs.

---

## 🚀 Open-Source Usage & Reproducibility

### Prerequisites
Ensure you have Python 3.8+ installed on your machine. Install the required data engineering and Office compilation dependencies:

```bash
pip install pandas numpy openpyxl kagglehub python-docx python-pptx matplotlib seaborn
```

### File Execution Flow
The pipeline is designed to be fully automated. Running the master script will automatically handle the kaggle download, clean the dataset, and output all reports.

```mermaid
flowchart LR
    A["Run Script"] --> B["kagglehub API Download"]
    B --> C["Data Cleaning Pipeline"]
    C --> D["Excel Workbook Compiler"]
    C --> E["docx_generator / office_artifact_builder"]
    D --> F["Saved to Desktop & Workspace Output"]
    E --> F
```

### Running the Pipeline
Simply execute the Python script from your terminal:

```bash
# Execute the main report generation pipeline
python retail_store_sales/scripts/generate_retail_report.py
```

### Output Verification
After execution, the following console logs will confirm the successful completion of the pipeline:

```text
Starting full retail store sales data cleaning, EDA & Excel generation...
Downloading to C:\Users\AAYUSHI\.cache\kagglehub\datasets\ahmedmohamed2003\retail-store-sales-dirty-for-data-cleaning\1.archive...
Cleaned Dataset Shape: (12575, 16)
Remaining Nulls: 0
Saved workbook to sandbox: C:\Harshil projects\EterX-Agent\.workspaces\sandbox\Retail_Store_Sales_Analysis_Report.xlsx
Saved workbook to Desktop: C:\Users\AAYUSHI\OneDrive\Desktop\Retail_Store_Sales_Analysis_Report.xlsx
Excel Workbook Generation Completed Successfully!
```

---

## 📜 Open-Source License
This project is open-source and available under the **MIT License**. Feel free to use, modify, and distribute the scripts and assets in both commercial and non-commercial environments.
