import kagglehub
import pandas as pd
import os
import numpy as np

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
print("\nMissing values per column:")
print(df.isnull().sum())

# Create a copy for cleaning
df_clean = df.copy()

# Separate numeric and categorical columns
numeric_cols = df_clean.select_dtypes(include=['float64', 'int64']).columns
categorical_cols = df_clean.select_dtypes(include=['object']).columns

print("\nNumeric columns:", list(numeric_cols))
print("Categorical columns:", list(categorical_cols))

# Fill missing numeric values with median
for col in numeric_cols:
    median_val = df_clean[col].median()
    df_clean[col] = df_clean[col].fillna(median_val)
    print(f"Filled missing values in {col} with median: {median_val}")

# Fill missing categorical values with mode
for col in categorical_cols:
    mode_val = df_clean[col].mode()[0]  # Get the first mode
    df_clean[col] = df_clean[col].fillna(mode_val)
    print(f"Filled missing values in {col} with mode: {mode_val}")
    
    # If the column is of object type, we want to strip whitespace from strings
    if df_clean[col].dtype == 'object':
        # Check if the column contains string-like data (we'll convert to string and strip)
        # But first, see if all non-null values are actually strings (or can be represented as strings)
        # We'll convert to string, strip, and then try to convert back to original type if possible
        # For simplicity, we'll just strip as strings and leave as strings.
        # However, for columns like 'Discount Applied' that might be boolean, we'll handle specially.
        if col == 'Discount Applied':
            # Try to convert to boolean if possible
            # Convert to string, strip, lower, then map to boolean
            # But note: after fillna, the column may have mixed types? We'll convert to string uniformly.
            df_clean[col] = df_clean[col].astype(str).str.strip().str.lower()
            # Map common true/false strings to boolean
            true_vals = {'true', 'yes', '1'}
            false_vals = {'false', 'no', '0'}
            # Create a boolean series, default to NaN for unrecognized
            def map_bool(val):
                if val in true_vals:
                    return True
                elif val in false_vals:
                    return False
                else:
                    return val  # return original if not recognized
            df_clean[col] = df_clean[col].apply(map_bool)
            # If any non-boolean values remain, leave them as is (could be strings)
        else:
            # For other object columns, just strip whitespace
            df_clean[col] = df_clean[col].astype(str).str.strip()

# Verify missing values after cleaning
print("\nMissing values after cleaning:")
print(df_clean.isnull().sum())

# Save the cleaned data to an Excel file
output_file = os.path.join(os.getcwd(), 'cleaned_retail_sales.xlsx')
df_clean.to_excel(output_file, index=False)
print(f"\nCleaned data saved to: {output_file}")

# Also save as CSV for completeness
csv_output = os.path.join(os.getcwd(), 'cleaned_retail_sales.csv')
df_clean.to_csv(csv_output, index=False)
print(f"Cleaned data saved to: {csv_output}")

# Optionally, show some stats
print("\n--- Summary Statistics ---")
print(df_clean.describe(include='all'))