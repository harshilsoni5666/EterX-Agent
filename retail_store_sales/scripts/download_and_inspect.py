import os
import glob
import pandas as pd
import numpy as np
import kagglehub

def main():
    print("Downloading dataset using kagglehub...")
    path = kagglehub.dataset_download("ahmedmohamed2003/retail-store-sales-dirty-for-data-cleaning")
    print("Dataset path:", path)
    
    # Locate CSV files in the downloaded path
    csv_files = glob.glob(os.path.join(path, "**", "*.csv"), recursive=True)
    if not csv_files:
        csv_files = glob.glob(os.path.join(path, "*.csv"))
    
    if not csv_files:
        raise FileNotFoundError(f"No CSV file found in dataset folder: {path}")
        
    csv_file = csv_files[0]
    print(f"Loading raw file: {csv_file}")
    df_raw = pd.read_csv(csv_file)
    print("Raw dataset info:")
    df_raw.info()
    print("Raw head preview:")
    print(df_raw.head())

if __name__ == "__main__":
    main()
