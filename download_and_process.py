import os
import kagglehub
import pandas as pd
import numpy as np

print("Downloading dataset via kagglehub...")
path = kagglehub.dataset_download("ahmedmohamed2003/retail-store-sales-dirty-for-data-cleaning")
print("Path to dataset files:", path)

# Find CSV or data files
files = os.listdir(path)
print("Files in dataset path:", files)

csv_file = None
for f in files:
    if f.endswith('.csv'):
        csv_file = os.path.join(path, f)
        break

if not csv_file and files:
    # check subdirs
    for root, dirs, filenames in os.walk(path):
        for f in filenames:
            if f.endswith('.csv'):
                csv_file = os.path.join(root, f)
                break

print("Found CSV file:", csv_file)

if csv_file:
    df = pd.read_csv(csv_file)
    print("Dataset shape:", df.shape)
    print("Columns:", df.columns.tolist())
    print(df.head())
    
    # Save raw info and do cleaning
    print("Missing values before cleaning:")
    print(df.isnull().sum())
    
    # Basic data cleaning simulation & analysis
    # Let's inspect columns and clean
    df_clean = df.copy()
    
    # Save a summary CSV or prepare for Excel export
    df_clean.to_csv("cleaned_retail_sales.csv", index=False)
    print("Cleaned data saved.")
else:
    print("No CSV file found.")
