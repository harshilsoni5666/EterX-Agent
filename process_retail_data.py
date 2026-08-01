import kagglehub
import pandas as pd
import os

# Download the dataset
print("Downloading dataset...")
path = kagglehub.dataset_download("ahmedmohamed2003/retail-store-sales-dirty-for-data-cleaning")
print("Path to dataset files:", path)

# List the files in the downloaded path
files = os.listdir(path)
print("Files in the dataset:", files)

# Assuming the dataset is a CSV file, we'll look for a CSV
csv_files = [f for f in files if f.endswith('.csv')]
if not csv_files:
    # If no CSV, try to find any file and see its content
    # But we expect a CSV
    raise FileNotFoundError("No CSV file found in the downloaded dataset.")
else:
    # Take the first CSV file
    csv_file = os.path.join(path, csv_files[0])
    print(f"Loading {csv_file}...")
    df = pd.read_csv(csv_file)

# Display basic info
print("\nDataset Info:")
print(df.info())
print("\nFirst 5 rows:")
print(df.head())

# Check for missing values
print("\nMissing values per column:")
print(df.isnull().sum())

# We'll do some cleaning:
# 1. For numerical columns, fill missing with median
# 2. For categorical columns, fill missing with mode
# 3. Standardize categorical values (strip whitespace)

# Identify column types
numerical_cols = df.select_dtypes(include=['number']).columns
categorical_cols = df.select_dtypes(include=['object']).columns

# Make a copy for cleaning
df_clean = df.copy()

# Fill numerical missing values with median
for col in numerical_cols:
    if df_clean[col].isnull().any():
        median_val = df_clean[col].median()
        df_clean[col].fillna(median_val, inplace=True)
        print(f"Filled missing values in {col} with median: {median_val}")

# Fill categorical missing values with mode
for col in categorical_cols:
    if df_clean[col].isnull().any():
        mode_val = df_clean[col].mode()[0] if not df_clean[col].mode().empty else ""
        df_clean[col].fillna(mode_val, inplace=True)
        print(f"Filled missing values in {col} with mode: {mode_val}")

# Standardize categorical columns: strip whitespace
for col in categorical_cols:
    if df_clean[col].dtype == 'object':
        # Remove leading/trailing whitespace
        df_clean[col] = df_clean[col].str.strip()

# Save the cleaned data to an Excel file on the desktop
desktop_path = os.path.join(os.path.expanduser('~'), 'OneDrive', 'Desktop')
excel_file = os.path.join(desktop_path, 'retail_store_sales_cleaned.xlsx')
print(f"\nSaving cleaned data to {excel_file}...")
df_clean.to_excel(excel_file, index=False)
print("Saved successfully.")

# Also, we can save a data summary or EDA results? The user didn't ask for that.
# We'll just save the cleaned data.

# Print the path of the Excel file
print(f"Cleaned dataset saved at: {excel_file}")