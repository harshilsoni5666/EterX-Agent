import os
import shutil

desktop_path = r"C:\Users\AAYUSHI\OneDrive\Desktop"
if not os.path.exists(desktop_path):
    desktop_path = r"C:\Users\AAYUSHI\Desktop"

target_dir = os.path.join(desktop_path, "Retail_Store_Sales_Professional_Charts")
os.makedirs(target_dir, exist_ok=True)

# Find where charts were saved
# In generate_charts.py, desktop_path was sandbox desktop
sandbox_desktop = os.path.join(os.path.expanduser('~'), 'Desktop')
if not os.path.exists(sandbox_desktop):
    sandbox_desktop = os.path.join(os.path.expanduser('~'), 'OneDrive', 'Desktop')

source_dir = os.path.join(sandbox_desktop, "Retail_Store_Sales_Professional_Charts")
if not os.path.exists(source_dir):
    # Search recursively from current workspace or home
    for root, dirs, files in os.walk(os.path.expanduser('~')):
        if "Retail_Store_Sales_Professional_Charts" in dirs:
            source_dir = os.path.join(root, "Retail_Store_Sales_Professional_Charts")
            break

print(f"Source dir: {source_dir}")
print(f"Target dir: {target_dir}")

if source_dir and os.path.exists(source_dir):
    for item in os.listdir(source_dir):
        s_path = os.path.join(source_dir, item)
        d_path = os.path.join(target_dir, item)
        if os.path.isfile(s_path):
            shutil.copy2(s_path, d_path)
            print(f"Copied {item}")
print("Done copying!")
