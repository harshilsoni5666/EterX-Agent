import requests
import json
import os

file_path = r'C:\Users\AAYUSHI\OneDrive\Desktop\Retail_Store_Sales_Analysis_Report.xlsx'
url = 'https://file.io'

try:
    with open(file_path, 'rb') as f:
        # File.io might need a different header or way of passing the file
        response = requests.post(url, files={'file': f})
        
    print(f"Status Code: {response.status_code}")
    print(f"Raw Response: {response.text}")
    
    if response.status_code == 200:
        data = response.json()
        print(f"LINK: {data.get('link')}")
except Exception as e:
    print(f"ERROR: {str(e)}")