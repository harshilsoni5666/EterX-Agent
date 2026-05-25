import { z } from 'zod';
import { ToolDefinition } from '../../schemas';
import path from 'path';
import fs from 'fs/promises';
import fse from 'fs-extra';
import { exec } from 'child_process';
import { promisify } from 'util';
import { resolveFinalArtifactPathForContext } from '../../workspace/path_resolver';

const execAsync = promisify(exec);

function ensureExtension(filePath: string, extension: string): string {
  return filePath.toLowerCase().endsWith(extension.toLowerCase()) ? filePath : `${filePath}${extension}`;
}

/**
 * Chart & Visualization Generator — Python-Powered
 * 
 * NEXT-GEN: Creates professional charts, graphs, diagrams, and data
 * visualizations using Python (matplotlib, seaborn, plotly).
 * 
 * This is the REAL image creation for data — not AI image gen.
 * For data visualizations, this is 100x better than AI image generators.
 * 
 * CHART TYPES:
 * - bar, line, pie, scatter, histogram, heatmap, box
 * - area, radar, donut, treemap, waterfall, gauge
 * - combination charts (bar + line overlay)
 * 
 * FEATURES:
 * - Dark theme by default (matches EterX brand)
 * - Professional styling with proper labels, legends, grids
 * - Auto-saves as PNG (high DPI)
 * - Also generates the Python script for user reference
 */
export const chartGeneratorTool: ToolDefinition = {
  name: 'chart_generator',
  description: `Generate professional charts and data visualizations using Python/matplotlib.

CHART TYPES: bar, horizontal_bar, line, area, pie, donut, scatter, bubble, histogram, heatmap, box, radar, waterfall, grouped_bar, stacked_bar, comparison, combo, gauge

USE THIS for:
- Stock comparisons → bar or line chart
- Data analysis results → histogram, scatter, box plot
- Market share → pie or donut chart
- Time series → line chart with trend
- Category comparisons → grouped bar chart
- Correlation → heatmap or scatter

INPUT:
- chartType: Type of chart
- title: Chart title
- data: The data to visualize (JSON object with labels and values)
- options: Styling options (colors, dark mode, etc.)

EXAMPLE:
{
  chartType: "bar",
  title: "Revenue by Quarter",
  data: { labels: ["Q1", "Q2", "Q3", "Q4"], values: [120, 180, 150, 210] },
  options: { ylabel: "Revenue ($M)", color: "#4facfe" }
}`,
  category: 'core',
  inputSchema: z.object({
    chartType: z.enum([
      'bar', 'horizontal_bar', 'line', 'pie', 'scatter', 'bubble',
      'histogram', 'heatmap', 'box', 'area', 'radar', 'donut',
      'waterfall', 'comparison', 'grouped_bar', 'stacked_bar', 'combo',
      'gauge'
    ]).describe('Type of chart to generate'),
    title: z.string().describe('Chart title'),
    data: z.object({
      labels: z.array(z.string()).optional().describe('X-axis labels or categories'),
      values: z.array(z.number()).optional().describe('Primary data values'),
      values2: z.array(z.number()).optional().describe('Secondary data values (for comparison charts)'),
      sizes: z.array(z.number()).optional().describe('Bubble sizes or additional magnitude values'),
      series: z.array(z.object({
        name: z.string(),
        values: z.array(z.number())
      })).optional().describe('Multiple data series (for grouped/multi-line charts)'),
      xValues: z.array(z.number()).optional().describe('X-axis numeric values (for scatter)'),
      yValues: z.array(z.number()).optional().describe('Y-axis numeric values (for scatter)'),
      matrix: z.array(z.array(z.number())).optional().describe('2D matrix data (for heatmap)')
    }).describe('Chart data'),
    options: z.object({
      xlabel: z.string().optional(),
      ylabel: z.string().optional(),
      color: z.string().optional(),
      colors: z.array(z.string()).optional(),
      darkMode: z.boolean().optional().default(true),
      legend: z.boolean().optional().default(true),
      grid: z.boolean().optional().default(true),
      width: z.number().optional().default(10),
      height: z.number().optional().default(6),
      label1: z.string().optional(),
      label2: z.string().optional(),
      min: z.number().optional(),
      max: z.number().optional(),
    }).optional().describe('Chart styling options'),
    filename: z.string().optional().describe('Custom filename')
  }),
  outputSchema: z.object({
    success: z.boolean(),
    imagePath: z.string(),
    scriptPath: z.string(),
    message: z.string()
  }),
  execute: async (input: {
    chartType: string, title: string,
    data: any, options?: any, filename?: string
  }, context?: any) => {
    const timestamp = Date.now();
    const filename = input.filename || `chart_${input.chartType}_${timestamp}`;
    const imagePath = ensureExtension(resolveFinalArtifactPathForContext(filename, '.png', input.title, context), '.png');
    const outputDir = path.dirname(imagePath);
    const scriptDir = path.resolve(process.cwd(), '.temp', 'chart-generator');
    const scriptPath = path.join(scriptDir, `${path.basename(imagePath, path.extname(imagePath))}.py`);
    await fse.ensureDir(outputDir);
    await fse.ensureDir(scriptDir);

    const opts = input.options || {};
    const darkMode = opts.darkMode !== false;
    const w = Math.min(24, Math.max(4, Number(opts.width) || 10));
    const h = Math.min(18, Math.max(3, Number(opts.height) || 6));

    console.log(`[Tool: chart_generator] Creating ${input.chartType} chart: "${input.title}"`);

    // Build the Python script
    const pythonScript = generatePythonScript(input, imagePath, opts, darkMode, w, h);

    // Save the script
    await fs.writeFile(scriptPath, pythonScript, 'utf-8');

    // Execute the Python script
    try {
      const { stdout, stderr } = await execAsync(`python "${scriptPath}"`, {
        timeout: 30000,
        cwd: outputDir
      });

      if (stderr && !stderr.includes('UserWarning')) {
        console.warn(`[chart_generator] Python stderr: ${stderr.substring(0, 200)}`);
      }

      if (await fse.pathExists(imagePath)) {
        const stats = await fs.stat(imagePath);
        console.log(`[chart_generator] ✅ Chart saved: ${imagePath} (${(stats.size / 1024).toFixed(1)} KB)`);
        return {
          success: true,
          imagePath,
          scriptPath,
          message: `Chart generated: ${path.basename(imagePath)} (${(stats.size / 1024).toFixed(1)} KB). Python script saved at: ${scriptPath}`
        };
      }

      return {
        success: false,
        imagePath: '',
        scriptPath,
        message: `Python ran but image not created. Check script at: ${scriptPath}. Stdout: ${stdout?.substring(0, 200)}`
      };

    } catch (err: any) {
      console.error(`[chart_generator] Python execution failed: ${err.message}`);

      // Try with python3
      try {
        await execAsync(`python3 "${scriptPath}"`, { timeout: 30000, cwd: outputDir });
        if (await fse.pathExists(imagePath)) {
          const stats = await fs.stat(imagePath);
          return {
            success: true,
            imagePath,
            scriptPath,
            message: `Chart generated (via python3): ${path.basename(imagePath)} (${(stats.size / 1024).toFixed(1)} KB)`
          };
        }
      } catch { }

      return {
        success: false,
        imagePath: '',
        scriptPath,
        message: `Python not available or script failed. Script saved at: ${scriptPath}. Error: ${err.message.substring(0, 200)}. Install: pip install matplotlib seaborn numpy`
      };
    }
  }
};

/**
 * Generate the Python matplotlib script for the given chart type
 */
function generatePythonScript(
  input: { chartType: string, title: string, data: any },
  imagePath: string,
  opts: any,
  darkMode: boolean,
  w: number,
  h: number
): string {
  const safeImagePath = imagePath.replace(/\\/g, '/');
  const py = (value: unknown) => JSON.stringify(value ?? '');
  const pyBool = (value: boolean) => value ? 'True' : 'False';
  const data = input.data || {};

  const darkSetup = darkMode ? `
import matplotlib
matplotlib.use('Agg')
import matplotlib.pyplot as plt
import numpy as np
from matplotlib.patches import Wedge
plt.style.use('dark_background')
plt.rcParams.update({
    'figure.facecolor': '#1a1a2e',
    'axes.facecolor': '#16213e',
    'axes.edgecolor': '#e94560',
    'axes.labelcolor': '#eee',
    'text.color': '#eee',
    'xtick.color': '#aaa',
    'ytick.color': '#aaa',
    'grid.color': '#333',
    'grid.alpha': 0.3,
    'font.family': 'sans-serif',
    'font.size': 12,
})
` : `
import matplotlib
matplotlib.use('Agg')
import matplotlib.pyplot as plt
import numpy as np
from matplotlib.patches import Wedge
plt.rcParams.update({'font.family': 'sans-serif', 'font.size': 12})
`;

  return `${darkSetup}

chart_type = ${py(input.chartType)}
title = ${py(input.title)}
raw_labels = ${py(data.labels || [])}
raw_values = ${py(data.values || [])}
raw_values2 = ${py(data.values2 || [])}
raw_sizes = ${py(data.sizes || [])}
raw_series = ${py(data.series || [])}
raw_x = ${py(data.xValues || [])}
raw_y = ${py(data.yValues || [])}
raw_matrix = ${py(data.matrix || [])}
xlabel = ${py(opts.xlabel || '')}
ylabel = ${py(opts.ylabel || '')}
color = ${py(opts.color || '#4facfe')}
colors = ${py(opts.colors || ['#4facfe', '#f093fb', '#43e97b', '#fa709a', '#fee140', '#a18cd1', '#fbc2eb', '#f5576c'])}
label1 = ${py(opts.label1 || 'Series 1')}
label2 = ${py(opts.label2 || 'Series 2')}
show_legend = ${pyBool(opts.legend !== false)}
show_grid = ${pyBool(opts.grid !== false)}
gauge_min = float(${py(typeof opts.min === 'number' ? opts.min : 0)})
gauge_max = float(${py(typeof opts.max === 'number' ? opts.max : 100)})
dark_mode = ${pyBool(darkMode)}

def as_float_list(seq):
    if not isinstance(seq, (list, tuple, np.ndarray)):
        return []
    out = []
    for item in seq:
        try:
            val = float(item)
            if np.isfinite(val):
                out.append(val)
        except Exception:
            continue
    return out

def as_label_list(seq):
    if not isinstance(seq, (list, tuple, np.ndarray)):
        return []
    return [str(item) for item in seq]

labels = as_label_list(raw_labels)
values = as_float_list(raw_values)
values2 = as_float_list(raw_values2)
sizes = as_float_list(raw_sizes)
x_values = as_float_list(raw_x)
y_values = as_float_list(raw_y)
series = []
if isinstance(raw_series, list):
    for idx, item in enumerate(raw_series):
        if isinstance(item, dict):
            vals = as_float_list(item.get('values', []))
            if vals:
                series.append({'name': str(item.get('name') or f'Series {idx + 1}'), 'values': vals})

def fallback_labels(count):
    return [f'Item {idx + 1}' for idx in range(max(count, 1))]

def align_category_values(primary, secondary=None):
    n = max(len(labels), len(primary), len(secondary or []), 1)
    labs = (labels + fallback_labels(n))[:n]
    vals = (primary + [0.0] * n)[:n]
    vals2 = ((secondary or []) + [0.0] * n)[:n]
    return labs, vals, vals2

def normalized_series():
    if series:
        n = max(len(labels), max(len(item['values']) for item in series), 1)
        labs = (labels + fallback_labels(n))[:n]
        return labs, [{'name': item['name'], 'values': (item['values'] + [0.0] * n)[:n]} for item in series]
    labs, vals, vals2 = align_category_values(values, values2)
    result = [{'name': label1, 'values': vals}]
    if values2:
        result.append({'name': label2, 'values': vals2})
    return labs, result

def palette(count):
    if not colors:
        return [color] * count
    return [colors[idx % len(colors)] for idx in range(count)]

def max_abs(*arrays):
    vals = []
    for arr in arrays:
        vals.extend([abs(v) for v in arr if np.isfinite(v)])
    return max(vals) if vals else 1.0

def add_bar_labels(ax, bars, vals, horizontal=False):
    offset = max_abs(vals) * 0.025
    for bar, val in zip(bars, vals):
        if horizontal:
            x = bar.get_width() + (offset if val >= 0 else -offset)
            y = bar.get_y() + bar.get_height() / 2
            ax.text(x, y, f'{val:,.0f}', ha='left' if val >= 0 else 'right', va='center', fontsize=9)
        else:
            x = bar.get_x() + bar.get_width() / 2
            y = bar.get_height() + (offset if val >= 0 else -offset)
            ax.text(x, y, f'{val:,.0f}', ha='center', va='bottom' if val >= 0 else 'top', fontsize=9)

def finish_axis(ax, x_label=True, y_label=True):
    ax.set_title(title, fontsize=16, fontweight='bold', pad=15)
    if x_label and xlabel:
        ax.set_xlabel(xlabel)
    if y_label and ylabel:
        ax.set_ylabel(ylabel)
    if show_grid:
        ax.grid(alpha=0.3)
    if hasattr(ax, 'spines'):
        ax.spines['top'].set_visible(False)
        ax.spines['right'].set_visible(False)

def save_chart(fig):
    try:
        fig.tight_layout()
    except Exception:
        pass
    fig.savefig(${py(safeImagePath)}, dpi=150, bbox_inches='tight', facecolor=fig.get_facecolor())
    plt.close(fig)
    print('Chart saved successfully')

fig, ax = plt.subplots(figsize=(${w}, ${h}))

if chart_type == 'bar':
    labs, vals, _ = align_category_values(values)
    x = np.arange(len(vals))
    bars = ax.bar(x, vals, color=palette(len(vals)), edgecolor='white', linewidth=0.5, alpha=0.9)
    ax.set_xticks(x)
    ax.set_xticklabels(labs, rotation=25 if len(labs) > 6 else 0, ha='right' if len(labs) > 6 else 'center')
    add_bar_labels(ax, bars, vals)
    finish_axis(ax)

elif chart_type == 'horizontal_bar':
    labs, vals, _ = align_category_values(values)
    y = np.arange(len(vals))
    bars = ax.barh(y, vals, color=palette(len(vals)), edgecolor='white', linewidth=0.5, alpha=0.9)
    ax.set_yticks(y)
    ax.set_yticklabels(labs)
    ax.invert_yaxis()
    add_bar_labels(ax, bars, vals, horizontal=True)
    finish_axis(ax)

elif chart_type == 'line':
    labs, vals, vals2 = align_category_values(values, values2)
    x = np.arange(len(labs))
    ax.plot(x, vals, color=color, linewidth=2.5, marker='o', markersize=7, label=label1)
    if values2:
        ax.plot(x, vals2, color=palette(2)[1], linewidth=2.5, marker='s', markersize=7, label=label2)
    ax.set_xticks(x)
    ax.set_xticklabels(labs, rotation=25 if len(labs) > 6 else 0, ha='right' if len(labs) > 6 else 'center')
    if show_legend and values2:
        ax.legend(fontsize=10)
    finish_axis(ax)

elif chart_type == 'area':
    labs, vals, vals2 = align_category_values(values, values2)
    x = np.arange(len(labs))
    ax.fill_between(x, vals, alpha=0.35, color=color)
    ax.plot(x, vals, color=color, linewidth=2, label=label1)
    if values2:
        ax.fill_between(x, vals2, alpha=0.2, color=palette(2)[1])
        ax.plot(x, vals2, color=palette(2)[1], linewidth=2, label=label2)
    ax.set_xticks(x)
    ax.set_xticklabels(labs, rotation=25 if len(labs) > 6 else 0, ha='right' if len(labs) > 6 else 'center')
    if show_legend and values2:
        ax.legend(fontsize=10)
    finish_axis(ax)

elif chart_type in ('pie', 'donut'):
    labs, vals, _ = align_category_values(values)
    filtered = [(lab, max(val, 0.0)) for lab, val in zip(labs, vals) if val > 0]
    if not filtered:
        filtered = [('No positive values', 1.0)]
    labs = [item[0] for item in filtered]
    vals = [item[1] for item in filtered]
    wedges, texts, autotexts = ax.pie(vals, labels=labs, colors=palette(len(vals)),
        autopct='%1.1f%%', startangle=90, pctdistance=0.82,
        wedgeprops=dict(linewidth=2, edgecolor='#1a1a2e' if dark_mode else 'white'))
    if chart_type == 'donut':
        ax.add_artist(plt.Circle((0, 0), 0.58, fc='#1a1a2e' if dark_mode else 'white'))
    for autotext in autotexts:
        autotext.set_fontsize(10)
        autotext.set_color('white')
    ax.set_title(title, fontsize=16, fontweight='bold', pad=20)

elif chart_type in ('scatter', 'bubble'):
    y = y_values or values
    x = x_values or list(range(1, len(y) + 1))
    n = max(min(len(x), len(y)), 1)
    x = (x + list(range(1, n + 1)))[:n]
    y = (y + [0.0] * n)[:n]
    bubble_sizes = sizes or values2 or [80.0] * n
    bubble_sizes = (bubble_sizes + [80.0] * n)[:n]
    scaled_sizes = [max(30.0, abs(size) * 20.0) for size in bubble_sizes] if chart_type == 'bubble' else 80
    ax.scatter(x, y, c=color, s=scaled_sizes, alpha=0.72, edgecolors='white', linewidth=0.5)
    finish_axis(ax)

elif chart_type == 'histogram':
    vals = values if values else [0.0]
    ax.hist(vals, bins='auto', color=color, edgecolor='white', linewidth=0.5, alpha=0.9)
    if not ylabel:
        ax.set_ylabel('Frequency')
    finish_axis(ax)

elif chart_type == 'heatmap':
    matrix = raw_matrix if isinstance(raw_matrix, list) and raw_matrix else []
    clean_rows = []
    for row in matrix:
        vals = as_float_list(row)
        if vals:
            clean_rows.append(vals)
    if not clean_rows:
        base = values if values else [0.0]
        clean_rows = [base]
    width = max(len(row) for row in clean_rows)
    clean_rows = [(row + [0.0] * width)[:width] for row in clean_rows]
    arr = np.array(clean_rows, dtype=float)
    im = ax.imshow(arr, cmap='YlOrRd', aspect='auto')
    for row_idx in range(arr.shape[0]):
        for col_idx in range(arr.shape[1]):
            ax.text(col_idx, row_idx, f'{arr[row_idx, col_idx]:.1f}', ha='center', va='center', fontsize=8, color='black')
    ax.set_xticks(np.arange(arr.shape[1]))
    ax.set_xticklabels((labels + fallback_labels(arr.shape[1]))[:arr.shape[1]], rotation=25, ha='right')
    ax.set_yticks(np.arange(arr.shape[0]))
    ax.set_yticklabels([f'Row {idx + 1}' for idx in range(arr.shape[0])])
    fig.colorbar(im, ax=ax, fraction=0.046, pad=0.04)
    finish_axis(ax, x_label=False, y_label=False)

elif chart_type == 'box':
    labs, normalized = normalized_series()
    box_data = [item['values'] for item in normalized if item['values']]
    box_labels = [item['name'] for item in normalized if item['values']]
    if not box_data:
        box_data, box_labels = [[0.0]], ['Data']
    bp = ax.boxplot(box_data, labels=box_labels, patch_artist=True)
    for patch, fill in zip(bp['boxes'], palette(len(box_data))):
        patch.set_facecolor(fill)
        patch.set_alpha(0.72)
    finish_axis(ax, x_label=False)

elif chart_type == 'radar':
    plt.close(fig)
    labs, vals, _ = align_category_values(values)
    angles = np.linspace(0, 2 * np.pi, len(vals), endpoint=False).tolist()
    vals = vals + vals[:1]
    angles = angles + angles[:1]
    fig = plt.figure(figsize=(${w}, ${h}))
    ax = fig.add_subplot(111, polar=True)
    ax.plot(angles, vals, color=color, linewidth=2.5)
    ax.fill(angles, vals, color=color, alpha=0.25)
    ax.set_xticks(angles[:-1])
    ax.set_xticklabels(labs)
    ax.set_title(title, fontsize=16, fontweight='bold', pad=20)

elif chart_type in ('grouped_bar', 'comparison'):
    labs, normalized = normalized_series()
    x = np.arange(len(labs))
    group_width = 0.82
    bar_width = group_width / max(len(normalized), 1)
    for idx, item in enumerate(normalized):
        offset = (idx - (len(normalized) - 1) / 2) * bar_width
        bars = ax.bar(x + offset, item['values'], bar_width, label=item['name'], color=palette(len(normalized))[idx], edgecolor='white', linewidth=0.4)
        if len(normalized) <= 3:
            add_bar_labels(ax, bars, item['values'])
    ax.set_xticks(x)
    ax.set_xticklabels(labs, rotation=25 if len(labs) > 6 else 0, ha='right' if len(labs) > 6 else 'center')
    if show_legend:
        ax.legend(fontsize=10)
    finish_axis(ax)

elif chart_type == 'stacked_bar':
    labs, normalized = normalized_series()
    x = np.arange(len(labs))
    bottom = np.zeros(len(labs))
    for idx, item in enumerate(normalized):
        vals = np.array(item['values'])
        ax.bar(x, vals, bottom=bottom, label=item['name'], color=palette(len(normalized))[idx], edgecolor='white', linewidth=0.4)
        bottom = bottom + vals
    ax.set_xticks(x)
    ax.set_xticklabels(labs, rotation=25 if len(labs) > 6 else 0, ha='right' if len(labs) > 6 else 'center')
    if show_legend:
        ax.legend(fontsize=10)
    finish_axis(ax)

elif chart_type == 'combo':
    labs, vals, vals2 = align_category_values(values, values2)
    x = np.arange(len(labs))
    bars = ax.bar(x, vals, color=color, alpha=0.72, edgecolor='white', linewidth=0.4, label=label1)
    add_bar_labels(ax, bars, vals)
    ax.set_xticks(x)
    ax.set_xticklabels(labs, rotation=25 if len(labs) > 6 else 0, ha='right' if len(labs) > 6 else 'center')
    ax2 = ax.twinx()
    line_values = vals2 if values2 else vals
    ax2.plot(x, line_values, color=palette(2)[1], marker='o', linewidth=2.5, label=label2 if values2 else 'Trend')
    ax2.spines['top'].set_visible(False)
    if show_legend:
        handles1, labels1 = ax.get_legend_handles_labels()
        handles2, labels2_ = ax2.get_legend_handles_labels()
        ax.legend(handles1 + handles2, labels1 + labels2_, fontsize=10)
    finish_axis(ax)

elif chart_type == 'waterfall':
    labs, vals, _ = align_category_values(values)
    cumulative = np.cumsum(vals)
    bottom = np.array([0.0] + cumulative[:-1].tolist())
    bar_colors = ['#43e97b' if v >= 0 else '#f5576c' for v in vals]
    bars = ax.bar(labs, vals, bottom=bottom, color=bar_colors, edgecolor='white', linewidth=0.5)
    for bar, val, bot in zip(bars, vals, bottom):
        ax.text(bar.get_x() + bar.get_width() / 2, bot + val / 2, f'{val:+,.0f}', ha='center', va='center', fontsize=9, fontweight='bold')
    finish_axis(ax)

elif chart_type == 'gauge':
    plt.close(fig)
    fig, ax = plt.subplots(figsize=(${w}, ${h}))
    ax.axis('equal')
    ax.axis('off')
    val = values[0] if values else gauge_min
    if gauge_max == gauge_min:
        gauge_max = gauge_min + 1
    pct = max(0.0, min(1.0, (val - gauge_min) / (gauge_max - gauge_min)))
    ax.add_patch(Wedge((0, 0), 1.0, 0, 180, width=0.24, facecolor='#30363d' if dark_mode else '#e5e7eb', edgecolor='none'))
    ax.add_patch(Wedge((0, 0), 1.0, 180 * (1 - pct), 180, width=0.24, facecolor=color, edgecolor='none'))
    angle = np.deg2rad(180 * (1 - pct))
    ax.plot([0, 0.72 * np.cos(angle)], [0, 0.72 * np.sin(angle)], color='white' if dark_mode else '#111827', linewidth=3)
    ax.scatter([0], [0], s=60, color='white' if dark_mode else '#111827')
    ax.text(0, -0.16, f'{val:,.1f}', ha='center', va='center', fontsize=22, fontweight='bold')
    ax.text(-1.0, -0.08, f'{gauge_min:,.0f}', ha='center', fontsize=9)
    ax.text(1.0, -0.08, f'{gauge_max:,.0f}', ha='center', fontsize=9)
    ax.set_title(title, fontsize=16, fontweight='bold', pad=15)
    ax.set_xlim(-1.15, 1.15)
    ax.set_ylim(-0.25, 1.15)

else:
    labs, vals, _ = align_category_values(values)
    x = np.arange(len(vals))
    ax.bar(x, vals, color=palette(len(vals)), edgecolor='white', linewidth=0.5)
    ax.set_xticks(x)
    ax.set_xticklabels(labs)
    finish_axis(ax)

save_chart(fig)
`;
}
