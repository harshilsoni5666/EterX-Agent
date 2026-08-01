import os
import glob
import kagglehub
import pandas as pd
import numpy as np

def analyze():
    path = kagglehub.dataset_download("ahmedmohamed2003/retail-store-sales-dirty-for-data-cleaning")
    csv_file = glob.glob(os.path.join(path, "**", "*.csv"), recursive=True)[0]
    df = pd.read_csv(csv_file)
    
    print("--- DATA INSPECTION & DIRTINESS AUDIT ---")
    print(f"Total Rows: {len(df)}")
    
    # 1. Duplicate Transaction IDs
    dup_txns = df[df.duplicated(subset=['Transaction ID'], keep=False)]
    print(f"Duplicate Transaction IDs count: {len(dup_txns)}")
    
    # 2. Category vs Item mapping
    cat_items = df.dropna(subset=['Item']).groupby(['Category', 'Item']).size().reset_index(name='count')
    print(f"Unique Items found: {df['Item'].nunique()}")
    print("Items per Category:")
    print(cat_items.groupby('Category')['Item'].count())
    
    # Check item suffix to category mapping
    # Item names like Item_2_BEV -> BEV = Beverages, FUR = Furniture, MILK = Milk Products, etc.
    item_cat = df.dropna(subset=['Item'])[['Item', 'Category']].drop_duplicates()
    print("Item-Category cross tab checks:")
    print(item_cat.head(15))
    
    # 3. Static Price check per Item
    price_by_item = df.dropna(subset=['Item', 'Price Per Unit']).groupby('Item')['Price Per Unit'].agg(['min', 'max', 'nunique', 'mean', 'count'])
    print("\nItem Price Consistency Check:")
    print("Items with > 1 price:", len(price_by_item[price_by_item['nunique'] > 1]))
    print(price_by_item.head(15))
    
    # Map item to static price
    item_price_map = df.dropna(subset=['Item', 'Price Per Unit']).groupby('Item')['Price Per Unit'].median().to_dict()
    # Also reverse map static price to item (if static price is unique)
    price_item_map = {v: k for k, v in item_price_map.items()}
    print(f"\nUnique item static prices: {len(set(item_price_map.values()))} out of {len(item_price_map)} items")
    
    # 4. Total Spent vs (Price Per Unit * Quantity)
    df_calc = df.dropna(subset=['Price Per Unit', 'Quantity', 'Total Spent']).copy()
    df_calc['expected_total'] = df_calc['Price Per Unit'] * df_calc['Quantity']
    df_calc['diff'] = df_calc['Total Spent'] - df_calc['expected_total']
    print(f"\nTotal Spent mismatch count (diff != 0): {(df_calc['diff'].abs() > 0.01).sum()}")
    print("Sample mismatches if any:")
    print(df_calc[df_calc['diff'].abs() > 0.01][['Price Per Unit', 'Quantity', 'Total Spent', 'expected_total', 'Discount Applied']].head(10))
    
    # 5. Quantity distribution & missing Total Spent or Quantity recovery
    print("\nQuantity min/max/nulls:")
    print(df['Quantity'].describe())
    print("\nPrice Per Unit min/max/nulls:")
    print(df['Price Per Unit'].describe())
    print("\nTotal Spent min/max/nulls:")
    print(df['Total Spent'].describe())

    # 6. Date validation
    print("\nDate range & invalid dates:")
    dates = pd.to_datetime(df['Transaction Date'], errors='coerce')
    print(f"Invalid dates count: {dates.isnull().sum()}")
    print(f"Min date: {dates.min()}, Max date: {dates.max()}")
    
    # 7. Discount Applied column
    print("\nDiscount Applied value counts including nulls:")
    print(df['Discount Applied'].value_counts(dropna=False))

if __name__ == "__main__":
    analyze()
