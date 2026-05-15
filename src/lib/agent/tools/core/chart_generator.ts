import { z } from 'zod';
import { ToolDefinition } from '../../schemas';
import path from 'path';
import fs from 'fs/promises';
import fse from 'fs-extra';
import { exec } from 'child_process';
import { promisify } from 'util';
import { resolveWorkspacePath } from '../../workspace/path_resolver';

const execAsync = promisify(exec);

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
  description: `Generate professional charts and data visualizations using Python (matplotlib/seaborn).

CHART TYPES: bar, line, pie, scatter, histogram, heatmap, box, area, donut, waterfall, comparison

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
      'bar', 'line', 'pie', 'scatter', 'histogram', 'heatmap',
      'box', 'area', 'donut', 'waterfall', 'comparison', 'grouped_bar'
    ]).describe('Type of chart to generate'),
    title: z.string().describe('Chart title'),
    data: z.object({
      labels: z.array(z.string()).optional().describe('X-axis labels or categories'),
      values: z.array(z.number()).optional().describe('Primary data values'),
      values2: z.array(z.number()).optional().describe('Secondary data values (for comparison charts)'),
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
  }) => {
    const timestamp = Date.now();
    const filename = input.filename || `chart_${input.chartType}_${timestamp}`;
    const baseFilePath = resolveWorkspacePath(filename);
    const outputDir = path.dirname(baseFilePath);
    await fse.ensureDir(outputDir);

    const imagePath = `${baseFilePath}.png`;
    const scriptPath = `${baseFilePath}.py`;

    const opts = input.options || {};
    const darkMode = opts.darkMode !== false;
    const w = opts.width || 10;
    const h = opts.height || 6;

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
          message: `Chart generated: ${filename}.png (${(stats.size / 1024).toFixed(1)} KB). Python script saved at: ${scriptPath}`
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
            message: `Chart generated (via python3): ${filename}.png (${(stats.size / 1024).toFixed(1)} KB)`
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
  const labels = JSON.stringify(input.data.labels || []);
  const values = JSON.stringify(input.data.values || []);
  const values2 = JSON.stringify(input.data.values2 || []);
  const color = opts.color || '#4facfe';
  const colors = JSON.stringify(opts.colors || ['#4facfe', '#f093fb', '#43e97b', '#fa709a', '#fee140', '#a18cd1', '#fbc2eb', '#f5576c']);
  const xlabel = opts.xlabel || '';
  const ylabel = opts.ylabel || '';
  const label1 = opts.label1 || 'Series 1';
  const label2 = opts.label2 || 'Series 2';

  const darkSetup = darkMode ? `
import matplotlib
matplotlib.use('Agg')
import matplotlib.pyplot as plt
import numpy as np
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
plt.rcParams.update({'font.family': 'sans-serif', 'font.size': 12})
`;

  const savePart = `
plt.tight_layout()
plt.savefig('${safeImagePath}', dpi=150, bbox_inches='tight', facecolor=fig.get_facecolor())
plt.close()
print('Chart saved successfully')
`;

  switch (input.chartType) {
    case 'bar':
      return `${darkSetup}
fig, ax = plt.subplots(figsize=(${w}, ${h}))
labels = ${labels}
values = ${values}
bars = ax.bar(labels, values, color='${color}', edgecolor='white', linewidth=0.5, alpha=0.9)
for bar, val in zip(bars, values):
    ax.text(bar.get_x() + bar.get_width()/2., bar.get_height() + max(values)*0.02,
            f'{val:,.0f}', ha='center', va='bottom', fontsize=10, color='white')
ax.set_title('${input.title}', fontsize=16, fontweight='bold', pad=15)
ax.set_xlabel('${xlabel}')
ax.set_ylabel('${ylabel}')
if ${opts.grid !== false}: ax.grid(axis='y', alpha=0.3)
ax.spines['top'].set_visible(False)
ax.spines['right'].set_visible(False)
${savePart}`;

    case 'line':
      return `${darkSetup}
fig, ax = plt.subplots(figsize=(${w}, ${h}))
labels = ${labels}
values = ${values}
ax.plot(labels, values, color='${color}', linewidth=2.5, marker='o', markersize=8, label='${label1}')
ax.fill_between(range(len(values)), values, alpha=0.15, color='${color}')
values2 = ${values2}
if values2:
    ax.plot(labels, values2, color='#f093fb', linewidth=2.5, marker='s', markersize=8, label='${label2}')
    ax.fill_between(range(len(values2)), values2, alpha=0.15, color='#f093fb')
    ax.legend(fontsize=11)
ax.set_title('${input.title}', fontsize=16, fontweight='bold', pad=15)
ax.set_xlabel('${xlabel}')
ax.set_ylabel('${ylabel}')
if ${opts.grid !== false}: ax.grid(alpha=0.3)
ax.spines['top'].set_visible(False)
ax.spines['right'].set_visible(False)
${savePart}`;

    case 'pie':
    case 'donut':
      return `${darkSetup}
fig, ax = plt.subplots(figsize=(${w}, ${h}))
labels = ${labels}
values = ${values}
colors_list = ${colors}[:len(labels)]
wedges, texts, autotexts = ax.pie(values, labels=labels, colors=colors_list,
    autopct='%1.1f%%', startangle=90, pctdistance=0.85,
    wedgeprops=dict(linewidth=2, edgecolor='${darkMode ? '#1a1a2e' : 'white'}'))
${input.chartType === 'donut' ? "centre_circle = plt.Circle((0,0), 0.60, fc='" + (darkMode ? '#1a1a2e' : 'white') + "')\nax.add_artist(centre_circle)" : ''}
for autotext in autotexts:
    autotext.set_fontsize(11)
    autotext.set_color('white')
ax.set_title('${input.title}', fontsize=16, fontweight='bold', pad=20)
${savePart}`;

    case 'scatter':
      return `${darkSetup}
fig, ax = plt.subplots(figsize=(${w}, ${h}))
x = ${JSON.stringify(input.data.xValues || input.data.values || [])}
y = ${JSON.stringify(input.data.yValues || input.data.values2 || [])}
scatter = ax.scatter(x, y, c='${color}', s=80, alpha=0.7, edgecolors='white', linewidth=0.5)
ax.set_title('${input.title}', fontsize=16, fontweight='bold', pad=15)
ax.set_xlabel('${xlabel}')
ax.set_ylabel('${ylabel}')
if ${opts.grid !== false}: ax.grid(alpha=0.3)
ax.spines['top'].set_visible(False)
ax.spines['right'].set_visible(False)
${savePart}`;

    case 'histogram':
      return `${darkSetup}
fig, ax = plt.subplots(figsize=(${w}, ${h}))
values = ${values}
ax.hist(values, bins='auto', color='${color}', edgecolor='white', linewidth=0.5, alpha=0.9)
ax.set_title('${input.title}', fontsize=16, fontweight='bold', pad=15)
ax.set_xlabel('${xlabel}')
ax.set_ylabel('${ylabel || "Frequency"}')
if ${opts.grid !== false}: ax.grid(axis='y', alpha=0.3)
ax.spines['top'].set_visible(False)
ax.spines['right'].set_visible(False)
${savePart}`;

    case 'heatmap':
      return `${darkSetup}
import seaborn as sns
fig, ax = plt.subplots(figsize=(${w}, ${h}))
data = np.array(${JSON.stringify(input.data.matrix || [[1,2],[3,4]])})
labels = ${labels}
sns.heatmap(data, annot=True, fmt='.1f', cmap='YlOrRd', ax=ax,
    xticklabels=labels[:data.shape[1]] if labels else True,
    yticklabels=labels[:data.shape[0]] if labels else True)
ax.set_title('${input.title}', fontsize=16, fontweight='bold', pad=15)
${savePart}`;

    case 'grouped_bar':
    case 'comparison':
      return `${darkSetup}
fig, ax = plt.subplots(figsize=(${w}, ${h}))
labels = ${labels}
values1 = ${values}
values2 = ${values2}
x = np.arange(len(labels))
width = 0.35
bars1 = ax.bar(x - width/2, values1, width, label='${label1}', color='${color}', edgecolor='white', linewidth=0.5)
bars2 = ax.bar(x + width/2, values2, width, label='${label2}', color='#f093fb', edgecolor='white', linewidth=0.5)
for bar, val in zip(bars1, values1):
    ax.text(bar.get_x() + bar.get_width()/2., bar.get_height() + max(max(values1), max(values2))*0.02,
            f'{val:,.0f}', ha='center', va='bottom', fontsize=9, color='white')
for bar, val in zip(bars2, values2):
    ax.text(bar.get_x() + bar.get_width()/2., bar.get_height() + max(max(values1), max(values2))*0.02,
            f'{val:,.0f}', ha='center', va='bottom', fontsize=9, color='white')
ax.set_xticks(x)
ax.set_xticklabels(labels)
ax.set_title('${input.title}', fontsize=16, fontweight='bold', pad=15)
ax.set_xlabel('${xlabel}')
ax.set_ylabel('${ylabel}')
ax.legend(fontsize=11)
if ${opts.grid !== false}: ax.grid(axis='y', alpha=0.3)
ax.spines['top'].set_visible(False)
ax.spines['right'].set_visible(False)
${savePart}`;

    case 'box':
      return `${darkSetup}
fig, ax = plt.subplots(figsize=(${w}, ${h}))
data = [${values}]
labels = ${labels} or ['Data']
bp = ax.boxplot(data, labels=labels[:len(data)], patch_artist=True)
for patch in bp['boxes']:
    patch.set_facecolor('${color}')
    patch.set_alpha(0.7)
ax.set_title('${input.title}', fontsize=16, fontweight='bold', pad=15)
ax.set_ylabel('${ylabel}')
if ${opts.grid !== false}: ax.grid(axis='y', alpha=0.3)
ax.spines['top'].set_visible(False)
ax.spines['right'].set_visible(False)
${savePart}`;

    case 'area':
      return `${darkSetup}
fig, ax = plt.subplots(figsize=(${w}, ${h}))
labels = ${labels}
values = ${values}
ax.fill_between(range(len(values)), values, alpha=0.4, color='${color}')
ax.plot(values, color='${color}', linewidth=2)
ax.set_xticks(range(len(labels)))
ax.set_xticklabels(labels)
ax.set_title('${input.title}', fontsize=16, fontweight='bold', pad=15)
ax.set_xlabel('${xlabel}')
ax.set_ylabel('${ylabel}')
if ${opts.grid !== false}: ax.grid(alpha=0.3)
ax.spines['top'].set_visible(False)
ax.spines['right'].set_visible(False)
${savePart}`;

    case 'waterfall':
      return `${darkSetup}
fig, ax = plt.subplots(figsize=(${w}, ${h}))
labels = ${labels}
values = ${values}
cumulative = np.cumsum(values)
colors_list = ['#43e97b' if v >= 0 else '#f5576c' for v in values]
bottom = [0] + list(cumulative[:-1])
bars = ax.bar(labels, values, bottom=bottom, color=colors_list, edgecolor='white', linewidth=0.5)
for bar, val, bot in zip(bars, values, bottom):
    y_pos = bot + val/2
    ax.text(bar.get_x() + bar.get_width()/2., y_pos,
            f'{val:+,.0f}', ha='center', va='center', fontsize=10, color='white', fontweight='bold')
ax.set_title('${input.title}', fontsize=16, fontweight='bold', pad=15)
ax.set_ylabel('${ylabel}')
if ${opts.grid !== false}: ax.grid(axis='y', alpha=0.3)
ax.spines['top'].set_visible(False)
ax.spines['right'].set_visible(False)
${savePart}`;

    default:
      return `${darkSetup}
fig, ax = plt.subplots(figsize=(${w}, ${h}))
labels = ${labels}
values = ${values}
ax.bar(labels, values, color='${color}')
ax.set_title('${input.title}', fontsize=16, fontweight='bold', pad=15)
${savePart}`;
  }
}
