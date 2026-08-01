import os
import glob
import kagglehub
import pandas as pd
import numpy as np

def test_recovery():
    path = kagglehub.dataset_download("ahmedmohamed2003/retail-store-sales-dirty-for-data-cleaning")
    csv_file = glob.glob(os.path.join(path, "**", "*.csv"), recursive=True)[0]
    df = pd.read_csv(csv_file)
    
    # Category to suffix map
    cat_to_suffix = {
        'Beverages': 'BEV',
        'Furniture': 'FUR',
        'Food': 'FOOD',
        'Milk Products': 'MILK',
        'Butchers': 'BUT',
        'Computers and electric accessories': 'CEA',
        'Electric household essentials': 'EHE',
        'Patisserie': 'PAT'
    }
    
    # Build item price map and price to item_number map
    known_items = df.dropna(subset=['Item', 'Price Per Unit'])
    item_to_price = known_items.groupby('Item')['Price Per Unit'].first().to_dict()
    
    # Check item_number to price
    item_num_to_price = {}
    for item, price in item_to_price.items():
        parts = item.split('_')
        num = int(parts[1])
        item_num_to_price[num] = price
        
    print("Item number to price map:")
    for num in sorted(item_num_to_price.keys()):
        print(f"Item #{num}: Price = ${item_num_to_price[num]}")
        
    price_to_item_num = {v: k for k, v in item_num_to_price.items()}
    print(f"\nAre prices unique per item number? {len(price_to_item_num) == len(item_num_to_price)} (25 prices for 25 item numbers)")

    # Test Recovery
    df_clean = df.copy()
    
    # Audit log trackers
    audit_counts = {
        'price_filled_from_item': 0,
        'price_filled_from_calc': 0,
        'quantity_filled_from_calc': 0,
        'total_spent_filled_from_calc': 0,
        'item_filled_from_price_and_cat': 0,
        'discount_filled_default': 0,
        'rows_unrecoverable_dropped': 0
    }
    
    # 1. Price recovery from Total Spent & Quantity
    mask_price_calc = df_clean['Price Per Unit'].isnull() & df_clean['Total Spent'].notnull() & df_clean['Quantity'].notnull() & (df_clean['Quantity'] > 0)
    df_clean.loc[mask_price_calc, 'Price Per Unit'] = df_clean.loc[mask_price_calc, 'Total Spent'] / df_clean.loc[mask_price_calc, 'Quantity']
    audit_counts['price_filled_from_calc'] = mask_price_calc.sum()
    
    # 2. Price recovery from Item
    mask_price_item = df_clean['Price Per Unit'].isnull() & df_clean['Item'].notnull()
    df_clean.loc[mask_price_item, 'Price Per Unit'] = df_clean.loc[mask_price_item, 'Item'].map(item_to_price)
    audit_counts['price_filled_from_item'] = mask_price_item.sum()

    # 3. Item recovery from Price Per Unit and Category
    mask_item_rec = df_clean['Item'].isnull() & df_clean['Price Per Unit'].notnull() & df_clean['Category'].notnull()
    def infer_item(row):
        price = row['Price Per Unit']
        cat = row['Category']
        if price in price_to_item_num and cat in cat_to_suffix:
            num = price_to_item_num[price]
            suf = cat_to_suffix[cat]
            return f"Item_{num}_{suf}"
        return np.nan
        
    inferred_items = df_clean[mask_item_rec].apply(infer_item, axis=1)
    df_clean.loc[mask_item_rec, 'Item'] = inferred_items
    audit_counts['item_filled_from_price_and_cat'] = inferred_items.notnull().sum()

    # 4. Quantity recovery from Total Spent and Price Per Unit
    mask_qty_calc = df_clean['Quantity'].isnull() & df_clean['Total Spent'].notnull() & df_clean['Price Per Unit'].notnull() & (df_clean['Price Per Unit'] > 0)
    df_clean.loc[mask_qty_calc, 'Quantity'] = df_clean.loc[mask_qty_calc, 'Total Spent'] / df_clean.loc[mask_qty_calc, 'Price Per Unit']
    audit_counts['quantity_filled_from_calc'] = mask_qty_calc.sum()

    # 5. Total Spent recovery from Price Per Unit and Quantity
    mask_total_calc = df_clean['Total Spent'].isnull() & df_clean['Price Per Unit'].notnull() & df_clean['Quantity'].notnull()
    df_clean.loc[mask_total_calc, 'Total Spent'] = df_clean.loc[mask_total_calc, 'Price Per Unit'] * df_clean.loc[mask_total_calc, 'Quantity']
    audit_counts['total_spent_filled_from_calc'] = mask_total_calc.sum()

    # Check remaining nulls
    print("\n--- NULL COUNTS AFTER RECOVERY STEP 1 ---")
    print(df_clean.isnull().sum())
    print("\nAudit Counts:")
    for k, v in audit_counts.items():
        print(f"{k}: {v}")

if __name__ == "__main__":
    test_recovery()
