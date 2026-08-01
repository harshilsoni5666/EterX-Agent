import os
import glob
import kagglehub
import pandas as pd
import numpy as np

def generate_cleaned_excel():
    print("Downloading dataset via kagglehub...")
    path = kagglehub.dataset_download("ahmedmohamed2003/retail-store-sales-dirty-for-data-cleaning")
    csv_file = glob.glob(os.path.join(path, "**", "*.csv"), recursive=True)[0]
    df = pd.read_csv(csv_file)
    
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
    
    known_items = df.dropna(subset=['Item', 'Price Per Unit'])
    item_to_price = known_items.groupby('Item')['Price Per Unit'].first().to_dict()
    
    item_num_to_price = {}
    for item, price in item_to_price.items():
        parts = item.split('_')
        num = int(parts[1])
        item_num_to_price[num] = price
        
    price_to_item_num = {v: k for k, v in item_num_to_price.items()}

    df_clean = df.copy()
    
    # 1. Price recovery from Total Spent & Quantity
    mask_price_calc = df_clean['Price Per Unit'].isnull() & df_clean['Total Spent'].notnull() & df_clean['Quantity'].notnull() & (df_clean['Quantity'] > 0)
    df_clean.loc[mask_price_calc, 'Price Per Unit'] = df_clean.loc[mask_price_calc, 'Total Spent'] / df_clean.loc[mask_price_calc, 'Quantity']
    
    # 2. Price recovery from Item
    mask_price_item = df_clean['Price Per Unit'].isnull() & df_clean['Item'].notnull()
    df_clean.loc[mask_price_item, 'Price Per Unit'] = df_clean.loc[mask_price_item, 'Item'].map(item_to_price)

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

    # 4. Quantity recovery from Total Spent and Price Per Unit
    mask_qty_calc = df_clean['Quantity'].isnull() & df_clean['Total Spent'].notnull() & df_clean['Price Per Unit'].notnull() & (df_clean['Price Per Unit'] > 0)
    df_clean.loc[mask_qty_calc, 'Quantity'] = df_clean.loc[mask_qty_calc, 'Total Spent'] / df_clean.loc[mask_qty_calc, 'Price Per Unit']

    # 5. Total Spent recovery from Price Per Unit and Quantity
    mask_total_calc = df_clean['Total Spent'].isnull() & df_clean['Price Per Unit'].notnull() & df_clean['Quantity'].notnull()
    df_clean.loc[mask_total_calc, 'Total Spent'] = df_clean.loc[mask_total_calc, 'Price Per Unit'] * df_clean.loc[mask_total_calc, 'Quantity']

    # Fill remaining categorical/payment method nulls if any
    if 'Payment Method' in df_clean.columns:
        df_clean['Payment Method'] = df_clean['Payment Method'].fillna('Unknown')
    if 'Discount Applied' in df_clean.columns:
        df_clean['Discount Applied'] = df_clean['Discount Applied'].fillna(False)

    desktop_path = r"C:\Users\AAYUSHI\OneDrive\Desktop\Retail_Store_Sales_Cleaned.xlsx"
    
    # Save to Excel
    with pd.ExcelWriter(desktop_path, engine='openpyxl') as writer:
        df_clean.to_excel(writer, sheet_name='Cleaned_Sales', index=False)
        
    print(f"Cleaned dataset successfully saved to: {desktop_path}")
    print(f"Total rows: {len(df_clean)}, Remaining nulls:\n{df_clean.isnull().sum()}")

if __name__ == "__main__":
    generate_cleaned_excel()
