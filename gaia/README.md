# GAIA Dataset Setup for EterX-Agent

The GAIA (General AI Assistants) dataset contains complex assistant tasks requiring advanced reasoning, web browsing, calculations, and file manipulation.

---

## 📂 Official Dataset Setup

The official GAIA benchmark dataset is gated and hosted on Hugging Face. Follow these steps to set it up locally:

### Step 1: Install Hugging Face Hub CLI or Library
Ensure you have `huggingface_hub` installed:
```bash
pip install huggingface_hub
```

### Step 2: Accept GAIA Gated Access
1. Go to the [GAIA Hugging Face Dataset Page](https://huggingface.co/datasets/gaia-benchmark/GAIA).
2. Log in and accept the terms of the dataset.

### Step 3: Download the Dataset and Attachments
Run the following Python script to download the entire repository (including the auxiliary folders with PDF, Excel, and media files):

```python
from huggingface_hub import snapshot_download

# This will download all metadata and level folders locally
download_dir = snapshot_download(
    repo_id="gaia-benchmark/GAIA",
    repo_type="dataset",
    local_dir="./gaia/data"
)
print(f"GAIA dataset successfully downloaded to: {download_dir}")
```

Once downloaded:
* Copy the `metadata.jsonl` (or Parquet files) to `./gaia/metadata.jsonl`.
* Keep the attachments (auxiliary files) directory structured under `./gaia/data/`.

---

## ⚡ Quick Start / Demo Evals

If you do not want to download the entire dataset, you can run the benchmark immediately using the sample suite:
```bash
npm run test:gaia
```
This runs against `gaia/sample_gaia_tasks.json` which contains public tasks requiring no Hugging Face credentials.
