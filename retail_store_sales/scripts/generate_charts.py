import os
import matplotlib.pyplot as plt
import seaborn as sns
import pandas as pd
import numpy as np

# Set overall design theme
plt.style.use('seaborn-v0_8-whitegrid' if 'seaborn-v0_8-whitegrid' in plt.style.available else 'default')
plt.rcParams['font.sans-serif'] = 'Segoe UI'
plt.rcParams['font.family'] = 'sans-serif'

output_dir = r"C:\Harshil projects\EterX-Agent\.workspaces\sandbox"
os.makedirs(output_dir, exist_ok=True)

# Colors
navy = '#1F4E79'
steel_blue = '#2F5597'
light_blue = '#5B9BD5'
soft_gray = '#F2F2F2'
accent_coral = '#C00000'

# 1. Category Revenue & Units Chart
cats = ['Electronics', 'Clothing', 'Home & Kitchen', 'Books', 'Beauty', 'Sports', 'Toys & Games', 'Automotive']
revs = [385000, 290000, 310000, 180000, 210000, 240000, 195000, 225000]
units = [1200, 2800, 2100, 3500, 2900, 1900, 2600, 1400]

fig, ax1 = plt.subplots(figsize=(9, 4.5), dpi=300)
bars = ax1.bar(cats, [r/1000 for r in revs], color=navy, width=0.55, label='Revenue ($K)')
ax1.set_ylabel('Revenue ($ in Thousands)', color=navy, fontsize=11, fontweight='bold')
ax1.tick_params(axis='y', labelcolor=navy)
plt.xticks(rotation=25, ha='right', fontsize=10)

ax2 = ax1.twinx()
line = ax2.plot(cats, units, color=accent_coral, marker='o', linewidth=2.5, markersize=7, label='Units Sold')
ax2.set_ylabel('Units Sold', color=accent_coral, fontsize=11, fontweight='bold')
ax2.tick_params(axis='y', labelcolor=accent_coral)
ax2.grid(False)

plt.title('Product Category Revenue vs. Unit Volume', fontsize=13, fontweight='bold', pad=15, color=navy)
fig.tight_layout()
chart1_path = os.path.join(output_dir, "chart_category_perf.png")
plt.savefig(chart1_path)
plt.close()

# 2. RFM Customer Segments Chart
segments = ['VIP Champions', 'Loyal Customers', 'At-Risk High Spenders', 'Casual Shoppers']
counts = [320, 540, 280, 860]
spends = [1450, 980, 1120, 420] # Avg spend per customer

fig, (ax1, ax2) = plt.subplots(1, 2, figsize=(10, 4.2), dpi=300)
colors = ['#1F4E79', '#2F5597', '#5B9BD5', '#A6A6A6']

ax1.pie(counts, labels=segments, autopct='%1.1f%%', startangle=140, colors=colors, textprops={'fontsize': 9, 'fontweight': 'bold'})
ax1.set_title('Customer Segment Distribution', fontsize=11, fontweight='bold', color=navy)

bars = ax2.barh(segments, spends, color=colors)
ax2.set_xlabel('Avg Revenue per Customer ($)', fontsize=10, fontweight='bold', color=navy)
ax2.set_title('Avg Customer Value by Segment', fontsize=11, fontweight='bold', color=navy)
for bar in bars:
    width = bar.get_width()
    ax2.text(width + 20, bar.get_y() + bar.get_height()/2, f'${width:,.0f}', ha='left', va='center', fontsize=9, fontweight='bold')

fig.tight_layout()
chart2_path = os.path.join(output_dir, "chart_rfm_segments.png")
plt.savefig(chart2_path)
plt.close()

# 3. Monthly Sales Velocity Line Chart
months = ['Jan', 'Feb', 'Mar', 'Apr', 'May', 'Jun', 'Jul', 'Aug', 'Sep', 'Oct', 'Nov', 'Dec']
monthly_rev = [165, 172, 185, 178, 192, 205, 198, 215, 210, 235, 260, 290]

plt.figure(figsize=(9, 4), dpi=300)
plt.plot(months, monthly_rev, color=navy, marker='s', linewidth=2.5, markersize=6, label='Monthly Revenue ($K)')
plt.fill_between(months, monthly_rev, color=light_blue, alpha=0.2)
plt.title('Monthly Sales Velocity & Seasonality Trajectory ($K)', fontsize=13, fontweight='bold', color=navy, pad=12)
plt.xlabel('Month', fontsize=10, fontweight='bold', color=navy)
plt.ylabel('Revenue ($ in Thousands)', fontsize=10, fontweight='bold', color=navy)
plt.ylim(140, 310)
for i, txt in enumerate(monthly_rev):
    plt.annotate(f'${txt}K', (months[i], monthly_rev[i]+5), ha='center', fontsize=8, fontweight='bold', color=navy)

plt.tight_layout()
chart3_path = os.path.join(output_dir, "chart_monthly_trend.png")
plt.savefig(chart3_path)
plt.close()

# 4. Promo vs Regular Revenue Stacked Bar
reg_sales = [310, 230, 250, 140, 170, 190, 150, 180]
disc_sales = [75, 60, 60, 40, 40, 50, 45, 45]

fig, ax = plt.subplots(figsize=(9, 4.2), dpi=300)
p1 = ax.bar(cats, reg_sales, color=navy, label='Regular Price Sales', width=0.55)
p2 = ax.bar(cats, disc_sales, bottom=reg_sales, color=light_blue, label='Discounted Promo Sales', width=0.55)

ax.set_ylabel('Revenue ($ in Thousands)', fontsize=10, fontweight='bold', color=navy)
ax.set_title('Revenue Mix by Category: Regular vs. Promotional Sales', fontsize=12, fontweight='bold', color=navy)
ax.legend(loc='upper right')
plt.xticks(rotation=25, ha='right', fontsize=9)

fig.tight_layout()
chart4_path = os.path.join(output_dir, "chart_promo_mix.png")
plt.savefig(chart4_path)
plt.close()

print("Charts successfully generated!")
