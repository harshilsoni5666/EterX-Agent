/**
 * EterX — Provider Manager
 * Rich terminal display of all providers with status, key counts, and URLs.
 */
const fs = require('fs');
const path = require('path');
const { ok, warn, fail, info, c, icons, header, line, doubleLine, boxMessage } = require('./banner');
const { PROVIDERS, SERVICES } = require('./providers');

function readEnv(projectRoot) {
  const envPath = path.join(projectRoot, '.env.local');
  if (!fs.existsSync(envPath)) return {};
  const vars = {};
  fs.readFileSync(envPath, 'utf8').split('\n').forEach(l => {
    if (l.startsWith('#') || !l.includes('=')) return;
    const [k, ...rest] = l.split('=');
    vars[k.trim()] = rest.join('=').trim();
  });
  return vars;
}

function listProviders(projectRoot) {
  const vars = readEnv(projectRoot);

  header(`${icons.model} Model Providers`);
  console.log();

  let activeProviders = 0;
  let activeServices = 0;

  for (const p of PROVIDERS) {
    const configured = p.envKeys.some(k => !!vars[k]);
    const multiCount = p.multiKey
      ? Object.keys(vars).filter(k => k.startsWith(p.envPrefix) && vars[k]).length
      : 0;

    if (configured) activeProviders++;

    const statusIcon = configured ? `${c.brightGreen}${icons.check}` : `${c.gray}○`;
    const statusText = configured
      ? `${c.brightGreen}Active${c.reset}${multiCount > 1 ? ` ${c.dim}(${multiCount} keys)${c.reset}` : ''}`
      : `${c.gray}Not configured${c.reset}`;
    const tag = p.required ? ` ${c.brightYellow}${icons.star} REQUIRED${c.reset}` : '';
    const localTag = p.noKeyRequired ? ` ${c.cyan}${icons.terminal} Local${c.reset}` : '';

    console.log(`  ${statusIcon}${c.reset} ${c.bold}${p.name}${c.reset}${tag}${localTag}  ${c.dim}—${c.reset} ${statusText}`);
    console.log(`    ${c.dim}${p.description}${c.reset}`);
    if (!configured && p.getUrl) {
      console.log(`    ${c.dim}${icons.arrow} ${c.cyan}${p.getUrl}${c.reset}`);
    }
    if (p.models && configured) {
      console.log(`    ${c.dim}${icons.model} Models: ${p.models.slice(0, 3).join(', ')}${p.models.length > 3 ? ` +${p.models.length - 3} more` : ''}${c.reset}`);
    }
    console.log();
  }

  line();
  header(`${icons.api} Service Integrations`);
  console.log();

  for (const s of SERVICES) {
    const configured = s.envKeys.some(k => !!vars[k]);
    if (configured) activeServices++;

    const statusIcon = configured ? `${c.brightGreen}${icons.check}` : `${c.gray}○`;
    const statusText = configured ? `${c.brightGreen}Active${c.reset}` : `${c.gray}Not configured${c.reset}`;

    console.log(`  ${statusIcon}${c.reset} ${c.bold}${s.name}${c.reset}  ${c.dim}—${c.reset} ${statusText}`);
    console.log(`    ${c.dim}${s.description}${c.reset}`);
    if (!configured && s.getUrl) {
      console.log(`    ${c.dim}${icons.arrow} ${c.cyan}${s.getUrl}${c.reset}`);
    }
    console.log();
  }

  doubleLine();
  const totalKeys = Object.keys(vars).filter(k => vars[k]).length;

  boxMessage(`${icons.chart} Provider Summary`, [
    `${icons.model} ${activeProviders}/${PROVIDERS.length} providers active`,
    `${icons.api} ${activeServices}/${SERVICES.length} services active`,
    `${icons.key} ${totalKeys} total API keys configured`,
    '',
    `${c.dim}Add more: ${c.reset}${c.bold}eterx config${c.reset}`,
  ]);
  console.log();
}

module.exports = { listProviders };
