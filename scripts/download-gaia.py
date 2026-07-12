import os
import sys

# Ensure required packages are installed
def install_and_import(package_name, import_name=None):
    if import_name is None:
        import_name = package_name
    try:
        __import__(import_name)
    except ImportError:
        print(f"Installing {package_name}...")
        os.system(f"{sys.executable} -m pip install {package_name}")

install_and_import("huggingface_hub")
install_and_import("pandas")
install_and_import("pyarrow")

from huggingface_hub import snapshot_download
import pandas as pd

# Get HF Token
hf_token = os.environ.get("HF_TOKEN")
if not hf_token:
    print("Please enter your Hugging Face Access Token.")
    print("If you do not have one, create it under settings -> access tokens on HF.")
    hf_token = input("HF Token (starts with hf_): ").strip()

if not hf_token:
    print("Error: HF_TOKEN is required to download the gated GAIA dataset.")
    sys.exit(1)

print("\n[Start] Starting GAIA validation dataset download from Hugging Face...")
try:
    # Download validation split metadata and files
    download_path = snapshot_download(
        repo_id="gaia-benchmark/GAIA",
        repo_type="dataset",
        allow_patterns=["2023/validation/*"],
        token=hf_token,
        local_dir="./gaia"
    )
    
    # Path to downloaded parquet
    parquet_path = os.path.join("./gaia", "2023", "validation", "metadata.parquet")
    jsonl_path = os.path.join("./gaia", "metadata.jsonl")
    
    if os.path.exists(parquet_path):
        print(f"Converting metadata from Parquet to JSONL: {parquet_path} -> {jsonl_path}")
        df = pd.read_parquet(parquet_path)
        
        # Convert df columns to match expected schema exactly if needed
        # We rename columns to ensure capitalization matches (e.g. Question -> Question)
        df.to_json(jsonl_path, orient="records", lines=True, force_ascii=False)
        print("Conversion complete!")
        
    print(f"\n[Success] GAIA Dataset successfully downloaded and prepared at: {os.path.abspath('./gaia')}")
    print("You can now run the GAIA benchmarks with: npm run test:gaia")
except Exception as e:
    print(f"\n[Error] Download/Preparation failed: {e}")
    print("Make sure:")
    print("1. You accepted the terms on: https://huggingface.co/datasets/gaia-benchmark/GAIA")
    print("2. Your Hugging Face Access Token starts with 'hf_' and has READ permission.")
