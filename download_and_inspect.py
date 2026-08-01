import os
import glob
import kagglehub
import pandas as pd

def main():
    print("Downloading dataset via kagglehub...")
    path = kagglehub.dataset_download("ahmedmohamed2003/retail-store-sales-dirty-for-data-cleaning")
    print("Path to dataset files:", path)
    
    csv_files = glob.glob(os.path.join(path, "*.csv"))
    print("Found CSV files:", csv_files)
    
    if not csv_files:
        # Check subdirectories
        csv_files = glob.glob(os.path.join(path, "**", "*.csv"), recursive=True)
        print("Recursive CSV files:", csv_files)
        
    for f in csv_files:
        df = pd.read_csv(f)
        print(f"\n--- File: {f} ---")
        print("Shape:", df.shape)
        print("Columns:", list(df.columns))
        print("\nHead:")
        print(df.head(10))
        print("\nInfo:")
        print(df.info())
        print("\nNull Counts:")
        print(df.isnull().sum())
        print("\nValue Counts for non-numeric columns:")
        for col in df.select_dtypes(include=['object']).columns:
            print(f"\nCol: {col}")
            print(df[col].value_counts(dropna=False).head(20))

if __name__ == "__main__":
    main()
