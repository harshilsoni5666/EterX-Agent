import os
import glob
import kagglehub
import pandas as pd

def inspect_remaining_nulls():
    path = kagglehub.dataset_download("ahmedmohamed2003/retail-store-sales-dirty-for-data-cleaning")
    csv_file = glob.glob(os.path.join(path, "**", "*.csv"), recursive=True)[0]
    df = pd.read_csv(csv_file)
    
    null_qty = df[df['Quantity'].isnull() & df['Total Spent'].isnull()]
    print(f"Rows where both Quantity and Total Spent are null: {len(null_qty)}")
    print(null_qty.head(10))
    print("\nAre there rows where only Quantity is null or only Total Spent is null?")
    print("Only Quantity null:", len(df[df['Quantity'].isnull() & df['Total Spent'].notnull()]))
    print("Only Total Spent null:", len(df[df['Total Spent'].isnull() & df['Quantity'].notnull()]))

    print("\nDiscount Applied value distribution:")
    print(df['Discount Applied'].value_counts(dropna=False))

if __name__ == "__main__":
    inspect_remaining_nulls()
