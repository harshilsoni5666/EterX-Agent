import pandas as pd
import numpy as np
import os

csv_path = r"C:\Harshil projects\EterX-Agent\.workspaces\sandboxes\local\default\a3795906-f8d4-430e-85a3-b6cc56570eba\command\tmp\.cache\kagglehub\datasets\ahmedmohamed2003\retail-store-sales-dirty-for-data-cleaning\versions\1\retail_store_sales.csv"

df = pd.read_csv(csv_path)

print("INITIAL NULL COUNTS:")
print(df.isnull().sum())

cat_suffix = {
    'Beverages': 'BEV',
    'Butchers': 'BUT',
    'Computers and electric accessories': 'CEA',
    'Electric household essentials': 'EHE',
    'Food': 'FOOD',
    'Furniture': 'FUR',
    'Milk Products': 'MILK',
    'Patisserie': 'PAT'
}

# 1. Price from Item
def price_from_item(item):
    if pd.isna(item): return np.nan
    try:
        parts = str(item).split('_')
        num = int(parts[1])
        return 5.0 + (num - 1) * 1.5
    except:
        return np.nan

df['Price Per Unit'] = df['Price Per Unit'].fillna(df['Item'].apply(price_from_item))

# 2. Price from Total / Quantity
df['Price Per Unit'] = df['Price Per Unit'].fillna(df['Total Spent'] / df['Quantity'])

# 3. Item from Category + Price
def get_item_name(row):
    if pd.notna(row['Item']):
        return row['Item']
    cat = row['Category']
    price = row['Price Per Unit']
    if pd.isna(price) or cat not in cat_suffix:
        return row['Item']
    num = int(round((price - 5.0) / 1.5)) + 1
    return f"Item_{num}_{cat_suffix[cat]}"

df['Item'] = df.apply(get_item_name, axis=1)

# 4. Quantity from Total / Price
df['Quantity'] = df['Quantity'].fillna(df['Total Spent'] / df['Price Per Unit'])

# 5. Total Spent from Price * Quantity
df['Total Spent'] = df['Total Spent'].fillna(df['Price Per Unit'] * df['Quantity'])

# 6. Discount Applied
# If missing, set to False or keep track
df['Discount Applied'] = df['Discount Applied'].fillna(False)

print("\nAFTER DETERMINISTIC CLEANING NULL COUNTS:")
print(df.isnull().sum())