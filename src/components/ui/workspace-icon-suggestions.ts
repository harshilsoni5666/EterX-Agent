import {
  Aperture, AppWindow, Archive, AudioLines, Blocks, BookOpen, Boxes, Braces, ChartLine, CircuitBoard,
  Cloud, Compass, Cpu, Database, DraftingCompass, FileText, Film, FlaskConical, FolderTree, Globe,
  HardDrive, Layers, LayoutDashboard, Map, MapPin, Network, NotebookPen, Package, Palette,
  PanelsTopLeft, PenTool, Pipette, Route, Server, Smartphone, SquareTerminal, Table2, WavesHorizontal, Workflow, Wrench,
} from 'lucide-react';
import type { WorkspaceFolderEntry } from '../../lib/workspace-folder-list';

export const workspaceGlyphs = {
  aperture: { icon: Aperture, label: 'Photo' },
  app: { icon: AppWindow, label: 'App' },
  archive: { icon: Archive, label: 'Archive' },
  audio: { icon: AudioLines, label: 'Audio' },
  blocks: { icon: Blocks, label: 'Modules' },
  book: { icon: BookOpen, label: 'Docs' },
  boxes: { icon: Boxes, label: 'Packages' },
  code: { icon: Braces, label: 'Code' },
  chart: { icon: ChartLine, label: 'Analytics' },
  circuit: { icon: CircuitBoard, label: 'Circuit' },
  cloud: { icon: Cloud, label: 'Cloud' },
  compass: { icon: Compass, label: 'Compass' },
  cpu: { icon: Cpu, label: 'Hardware' },
  database: { icon: Database, label: 'Database' },
  design: { icon: DraftingCompass, label: 'Design' },
  document: { icon: FileText, label: 'Document' },
  film: { icon: Film, label: 'Video' },
  flask: { icon: FlaskConical, label: 'Lab' },
  folders: { icon: FolderTree, label: 'Files' },
  globe: { icon: Globe, label: 'Web' },
  drive: { icon: HardDrive, label: 'Storage' },
  layers: { icon: Layers, label: 'Layers' },
  dashboard: { icon: LayoutDashboard, label: 'Dashboard' },
  map: { icon: Map, label: 'Map' },
  pin: { icon: MapPin, label: 'Location' },
  network: { icon: Network, label: 'Network' },
  notebook: { icon: NotebookPen, label: 'Notes' },
  package: { icon: Package, label: 'Package' },
  palette: { icon: Palette, label: 'Palette' },
  layout: { icon: PanelsTopLeft, label: 'Layout' },
  pen: { icon: PenTool, label: 'Vector' },
  pipette: { icon: Pipette, label: 'Color' },
  route: { icon: Route, label: 'Routes' },
  server: { icon: Server, label: 'Server' },
  phone: { icon: Smartphone, label: 'Mobile' },
  terminal: { icon: SquareTerminal, label: 'Terminal' },
  table: { icon: Table2, label: 'Tables' },
  waves: { icon: WavesHorizontal, label: 'Water' },
  workflow: { icon: Workflow, label: 'Workflow' },
  wrench: { icon: Wrench, label: 'Tools' },
} as const;

export type WorkspaceGlyph = keyof typeof workspaceGlyphs;

export function isWorkspaceGlyph(value: unknown): value is WorkspaceGlyph {
  return typeof value === 'string' && Object.prototype.hasOwnProperty.call(workspaceGlyphs, value);
}

type FolderProfile = {
  words: readonly string[];
  files?: RegExp;
  directories?: RegExp;
  extensions?: RegExp;
  glyphs: readonly WorkspaceGlyph[];
};

const profiles: readonly FolderProfile[] = [
  {
    words: ['lake', 'lakebed', 'river', 'ocean', 'water', 'geospatial', 'gis', 'maps', 'mapping', 'terrain'],
    directories: /^(gis|geo|maps|tiles|shapefiles)$/,
    extensions: /\.(geojson|gpkg|shp|kml|geotiff|qgs|qgz)$/,
    glyphs: ['map', 'waves', 'pin', 'compass', 'layers', 'globe', 'route', 'chart', 'table', 'database'],
  },
  {
    words: ['data', 'analytics', 'database', 'warehouse', 'lakehouse', 'etl', 'metrics', 'reporting'],
    files: /^(dbt_project\.ya?ml|schema\.prisma|schema\.sql|duckdb\.ini)$/,
    directories: /^(data|datasets|migrations|warehouse|sql|tables)$/,
    extensions: /\.(sql|csv|parquet|duckdb|sqlite3?)$/,
    glyphs: ['database', 'table', 'chart', 'drive', 'workflow', 'layers', 'dashboard', 'archive', 'server', 'network'],
  },
  {
    words: ['design', 'designsystem', 'brand', 'creative', 'ux', 'ui', 'graphics', 'typography'],
    files: /^(figma\.json|design-tokens\.json|tokens\.json)$/,
    directories: /^(design|figma|illustrations|typography|tokens|components)$/,
    extensions: /\.(fig|sketch|ai|psd|afdesign)$/,
    glyphs: ['pen', 'design', 'palette', 'layout', 'pipette', 'layers', 'aperture', 'app', 'blocks', 'book'],
  },
  {
    words: ['web', 'website', 'frontend', 'front', 'site', 'dashboard', 'landing', 'portal', 'storefront'],
    files: /^(index\.html|(next|vite|nuxt|astro|svelte|vue)\.config\.[cm]?[jt]s|angular\.json)$/,
    directories: /^(pages|public|static|routes|views)$/,
    extensions: /\.(html|astro|vue|svelte)$/,
    glyphs: ['globe', 'app', 'layout', 'dashboard', 'code', 'layers', 'route', 'network', 'blocks', 'server'],
  },
  {
    words: ['ios', 'android', 'mobile', 'flutter', 'reactnative'],
    files: /^(pubspec\.yaml|podfile|app\.config\.(js|ts)|settings\.gradle(\.kts)?)$/,
    directories: /^(ios|android)$/,
    extensions: /\.(xcodeproj|xcworkspace|swift|dart|apk)$/,
    glyphs: ['phone', 'app', 'layout', 'blocks', 'code', 'package', 'layers', 'design', 'network', 'terminal'],
  },
  {
    words: ['infra', 'infrastructure', 'devops', 'cloud', 'deploy', 'platform', 'cluster', 'backend', 'server', 'api'],
    files: /^(dockerfile([.-].+)?|(docker-)?compose\.ya?ml|terraform\.tfvars|kustomization\.ya?ml|chart\.yaml)$/,
    directories: /^(infra|k8s|helm|terraform|ansible|deploy|deployments|services|server)$/,
    extensions: /\.(tf|tfvars)$/,
    glyphs: ['cloud', 'server', 'network', 'workflow', 'terminal', 'boxes', 'route', 'drive', 'database', 'wrench'],
  },
  {
    words: ['docs', 'documentation', 'writing', 'handbook', 'notes', 'wiki', 'book', 'journal'],
    files: /^(mkdocs\.ya?ml|docusaurus\.config\.(js|ts)|conf\.py|book\.toml)$/,
    directories: /^(docs|handbook|notes|chapters|wiki)$/,
    extensions: /\.(mdx|rst|adoc|docx|odt|epub)$/,
    glyphs: ['book', 'notebook', 'document', 'archive', 'folders', 'layers', 'pen', 'table', 'layout', 'globe'],
  },
  {
    words: ['media', 'video', 'audio', 'photos', 'photo', 'images', 'podcast', 'film', 'gallery'],
    directories: /^(audio|video|photos|footage|music|recordings)$/,
    extensions: /\.(mp3|wav|flac|mp4|mov|mkv|jpe?g|raw|heic)$/,
    glyphs: ['aperture', 'film', 'audio', 'archive', 'drive', 'palette', 'layers', 'layout', 'pen', 'folders'],
  },
  {
    words: ['research', 'science', 'experiment', 'lab', 'model', 'ml', 'training', 'notebooks'],
    files: /^(environment\.ya?ml|conda\.ya?ml|mlproject)$/,
    directories: /^(notebooks|experiments|models|research)$/,
    extensions: /\.(ipynb|onnx|safetensors)$/,
    glyphs: ['flask', 'notebook', 'chart', 'cpu', 'table', 'code', 'database', 'workflow', 'circuit', 'archive'],
  },
  {
    words: ['embedded', 'firmware', 'hardware', 'electronics', 'robotics', 'pcb'],
    files: /^(platformio\.ini|cmakelists\.txt|sdkconfig)$/,
    directories: /^(board|boards|firmware|hardware|drivers|electronics)$/,
    extensions: /\.(ino|kicad_pcb|kicad_pro|sch)$/,
    glyphs: ['circuit', 'cpu', 'wrench', 'terminal', 'design', 'boxes', 'workflow', 'network', 'drive', 'flask'],
  },
  {
    words: ['sdk', 'cli', 'code', 'library', 'package', 'packages', 'tools', 'toolkit', 'scripts'],
    files: /^(package\.json|pyproject\.toml|go\.mod|cargo\.toml|gemfile|pom\.xml|composer\.json|deno\.jsonc?)$/,
    directories: /^(src|packages|scripts|lib|tests|test)$/,
    extensions: /\.(tsx?|jsx?|py|go|rs|java|rb|cs|cpp)$/,
    glyphs: ['code', 'terminal', 'package', 'blocks', 'wrench', 'boxes', 'workflow', 'layers', 'book', 'folders'],
  },
];

const generalGlyphs: readonly WorkspaceGlyph[] = ['folders', 'layers', 'blocks', 'compass', 'archive', 'package', 'layout', 'code', 'wrench', 'book'];
const glyphIds = Object.keys(workspaceGlyphs).filter(isWorkspaceGlyph);
const batchSize = 5;

function rotateGlyphs(glyphs: readonly WorkspaceGlyph[], seed: number) {
  const start = seed % glyphs.length;
  return [...glyphs.slice(start), ...glyphs.slice(0, start)];
}

export function suggestWorkspaceIcons(
  folder: { identity: string; name: string },
  entries: readonly Pick<WorkspaceFolderEntry, 'name' | 'type'>[],
  batch: number,
): WorkspaceGlyph[] {
  const words = new Set(folder.name.normalize('NFKC').replace(/([a-z0-9])([A-Z])/g, '$1 $2').toLowerCase().match(/[\p{L}\p{N}]+/gu) ?? []);
  let seed = 2166136261;
  for (const character of folder.identity) seed = Math.imul(seed ^ (character.codePointAt(0) ?? 0), 16777619);
  seed >>>= 0;

  const directories = entries.filter(entry => entry.type === 'directory').map(entry => entry.name.toLowerCase());
  const files = entries.filter(entry => entry.type === 'file').map(entry => entry.name.toLowerCase());
  const matches = (names: string[], pattern?: RegExp) => pattern ? names.filter(name => pattern.test(name)).length : 0;
  const ranked = profiles.map(profile => ({
    glyphs: profile.glyphs,
    score: Math.min(2, profile.words.filter(word => words.has(word)).length) * 9
      + Math.min(2, matches(files, profile.files)) * 7
      + Math.min(2, matches(directories, profile.directories)) * 3
      + Math.min(3, matches(files, profile.extensions)) * 2,
  })).filter(profile => profile.score > 0).sort((a, b) => b.score - a.score);

  const [primary, secondary, ...others] = ranked;
  const related = primary ? rotateGlyphs(primary.glyphs.slice(3), seed) : [];
  const blend = primary && secondary && secondary.score >= primary.score * 0.55 ? secondary.glyphs.slice(0, 2) : [];
  const ordered = [...new Set([
    ...(primary?.glyphs.slice(0, 3) ?? []),
    ...blend,
    ...related,
    ...(secondary?.glyphs ?? []),
    ...others.flatMap(profile => profile.glyphs),
    ...rotateGlyphs(generalGlyphs, seed),
    ...rotateGlyphs(glyphIds, seed),
  ])];
  return rotateGlyphs(ordered, batch * batchSize).slice(0, batchSize);
}
