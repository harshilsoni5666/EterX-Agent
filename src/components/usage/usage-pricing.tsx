import { Fragment, useMemo, useState } from 'react';
import * as Dialog from '@radix-ui/react-dialog';
import { BarChart3, ChevronRight, ExternalLink, Info, X } from 'lucide-react';
import type { UsageRateLine } from '../../lib/usage/accounting';
import type { UsageTotals } from '../../lib/usage/summary';
import { catalogLinks, chargeLabels, chargeQuantity, chargeUnitLabel, exactCount, percent, pricedCount, usageValue, usd, usdRate } from './usage-format';
import styles from './usage-dashboard.module.css';

const chargeOrder = Object.keys(chargeLabels);
function groupCharges(lines: UsageRateLine[]) {
  const groups = new Map<string, { summary: UsageRateLine; rates: UsageRateLine[] }>();
  for (const line of lines) {
    const key = line.kind + '/' + line.unit;
    const group = groups.get(key);
    if (group) {
      group.summary.quantity += line.quantity;
      group.summary.cost += line.cost;
      group.rates.push(line);
    } else groups.set(key, { summary: { ...line }, rates: [line] });
  }
  return Array.from(groups, ([key, value]) => ({ key, ...value }))
    .sort((a, b) => chargeOrder.indexOf(a.summary.kind) - chargeOrder.indexOf(b.summary.kind));
}

export function CostTable({ totals, rates }: { totals: UsageTotals; rates: UsageRateLine[] }) {
  const [expanded, setExpanded] = useState<Record<string, boolean>>({});
  const groups = useMemo(() => groupCharges(rates), [rates]);
  if (!pricedCount(totals)) {
    return <p className={styles.emptyRows}>{totals.calls ? 'No responses in this selection have an available cost.' : 'No recorded usage in this selection.'}</p>;
  }
  return <><div className={styles.tableScroll}><table>
    <thead><tr>
      <th scope="col">Usage type</th><th scope="col">Quantity</th><th scope="col">API rate</th><th scope="col">Value</th>
    </tr></thead>
    <tbody>
      {groups.map(({ key, summary, rates: choices }) => {
        const multiple = choices.length > 1;
        const open = multiple && Boolean(expanded[key]);
        return <Fragment key={key}>
          <tr>
            <th scope="row">{chargeLabels[summary.kind]}</th>
            <td>{chargeQuantity(summary.quantity, summary.unit)}</td>
            <td>{multiple ? <button type="button" className={styles.inlineAction} aria-expanded={open}
              aria-label={(open ? 'Hide' : 'Show') + ' rates for ' + chargeLabels[summary.kind]}
              onClick={() => setExpanded(previous => ({ ...previous, [key]: !open }))}>
              {exactCount(choices.length)} rates<ChevronRight size={13} aria-hidden="true" data-open={open || undefined} />
            </button> : <>{usdRate(summary.rate)} <small className={styles.inlineUnit}>{chargeUnitLabel(summary.unit)}</small></>}</td>
            <td className={styles.tableValue}>{usd(summary.cost)}</td>
          </tr>
          {open && [...choices].sort((a, b) => a.rate - b.rate).map(line => <tr key={line.rate} data-rate-detail>
            <th scope="row">Rate detail</th><td>{chargeQuantity(line.quantity, line.unit)}</td>
            <td>{usdRate(line.rate)} <small className={styles.inlineUnit}>{chargeUnitLabel(line.unit)}</small></td>
            <td>{usd(line.cost)}</td>
          </tr>)}
        </Fragment>;
      })}
      {!!totals.estimated && <tr className={styles.subtotalRow}>
        <th scope="row">Public rate estimate</th><td colSpan={2}>{exactCount(totals.estimated)} responses</td>
        <td className={styles.tableValue}>{usd(totals.estimatedCost)}</td>
      </tr>}
      {!!totals.reported && <tr className={styles.subtotalRow}>
        <th scope="row">Provider-reported cost</th><td colSpan={2}>{exactCount(totals.reported)} responses</td>
        <td className={styles.tableValue}>{usd(totals.reportedCost)}</td>
      </tr>}
    </tbody>
    <tfoot><tr><th scope="row" colSpan={3}>Total usage value</th><td>{usageValue(totals)}</td></tr></tfoot>
  </table></div>
    {!!groups.length && <p className={styles.footnote}>Amounts are rounded for display.</p>}
  </>;
}

function PriceSources({ asOf }: { asOf: string }) {
  return <details className={styles.pricingSources}>
    <summary>Public rate catalogs</summary>
    <p className={styles.footnote}>Catalog snapshot {asOf}</p>
    <div>{catalogLinks.map(([name, url]) =>
      <a href={url} target="_blank" rel="noreferrer" key={url}>{name}<ExternalLink size={11} aria-hidden="true" /></a>)}</div>
  </details>;
}

export function CostCoverage({ totals, asOf, scopeLabel, timeZone, onExplain }: {
  totals: UsageTotals;
  asOf: string;
  scopeLabel?: string;
  timeZone: string;
  onExplain: (trigger: HTMLButtonElement) => void;
}) {
  const count = pricedCount(totals);
  return <aside className={styles.coverage} aria-label="Cost coverage">
    <div className={styles.sectionHead}><h2>Cost coverage</h2><BarChart3 size={16} aria-hidden="true" /></div>
    {scopeLabel && <p className={styles.coverageScope}>{scopeLabel}</p>}
    <strong className={styles.coverageValue}>{percent(count, totals.calls)}</strong>
    <p className={styles.note}>{exactCount(count)} of {exactCount(totals.calls)} responses priced</p>
    <div className={styles.coverageBar} aria-hidden="true">
      <span style={{ width: (totals.calls ? totals.reported / totals.calls * 100 : 0) + '%' }} />
      <span style={{ width: (totals.calls ? totals.estimated / totals.calls * 100 : 0) + '%' }} />
    </div>
    <dl className={styles.definitionList}>
      <div><dt><i data-basis="reported" />Provider reported</dt><dd>{exactCount(totals.reported)}</dd></div>
      <div><dt><i data-basis="estimated" />Model rate estimate</dt><dd>{exactCount(totals.estimated)}</dd></div>
      <div><dt><i data-basis="unpriced" />Unpriced</dt><dd>{exactCount(totals.unpriced)}</dd></div>
      <div className={styles.savings}><dt>Estimated cache-read savings</dt><dd>{usd(totals.saving)}</dd></div>
    </dl>
    {!!totals.calls && <button type="button" className={styles.inlineAction} aria-haspopup="dialog" onClick={event => onExplain(event.currentTarget)}>
      <Info size={14} aria-hidden="true" />How costs are calculated
    </button>}
    <PriceSources asOf={asOf} />
    <p className={styles.coverageScope}>Calendar zone · {timeZone}</p>
  </aside>;
}

export function ModelPriceDetails({ provider, model, totals, asOf }: {
  provider: string;
  model: string;
  totals: UsageTotals;
  asOf: string;
}) {
  const coverage = (count: number) => !totals.calls ? '—' : exactCount(count) + ' of ' + exactCount(totals.calls);
  return <>
    <section className={styles.subPanel} aria-label="Price details">
      <div className={styles.sectionHead}><h2>Price details</h2></div>
      <dl className={styles.definitionList} data-divided>
        <div><dt>Provider</dt><dd>{provider}</dd></div>
        <div><dt>Model ID</dt><dd className={styles.modelId}>{model}</dd></div>
        <div><dt>Priced responses</dt><dd>{coverage(pricedCount(totals))}</dd></div>
      </dl>
      <PriceSources asOf={asOf} />
    </section>
    <section className={styles.subPanel} aria-label="Recorded usage quality">
      <div className={styles.sectionHead}><h2>Recorded usage quality</h2></div>
      <dl className={styles.definitionList} data-divided>
        <div><dt>Input tokens reported</dt><dd>{coverage(totals.inputReports)}</dd></div>
        <div><dt>Output tokens reported</dt><dd>{coverage(totals.outputReports)}</dd></div>
        <div><dt>Cache detail reported</dt><dd>{coverage(totals.cacheReports)}</dd></div>
      </dl>
    </section>
  </>;
}

export function UsageCostDialog({ open, container, totals, rates, scopeLabel, asOf, onClose, onRestoreFocus }: {
  open: boolean;
  container: HTMLElement | null;
  totals: UsageTotals;
  rates: UsageRateLine[];
  scopeLabel: string;
  asOf: string;
  onClose: () => void;
  onRestoreFocus: () => void;
}) {
  return <Dialog.Root open={open} onOpenChange={next => { if (!next) onClose(); }}>
    <Dialog.Portal container={container}>
      <Dialog.Overlay className={styles.dialogOverlay} />
      <Dialog.Content className={styles.dialog} onCloseAutoFocus={event => {
        event.preventDefault();
        onRestoreFocus();
      }}>
        <div className={styles.dialogHeader}>
          <Dialog.Title>How this value is calculated</Dialog.Title>
          <Dialog.Close asChild><button type="button" className={styles.iconButton} aria-label="Close cost explanation">
            <X size={17} aria-hidden="true" />
          </button></Dialog.Close>
        </div>
        <p className={styles.dialogScope}>{scopeLabel}</p>
        <Dialog.Description className={styles.note}>
          EterX uses costs reported by providers when available. For estimates, it applies public model rates to measured usage. Subscription activity is valued at API rates.
        </Dialog.Description>
        <CostTable totals={totals} rates={rates} />
        {!!totals.unpriced && <section className={styles.unpricedSection} aria-label="Unpriced responses">
          <h3>{exactCount(totals.unpriced)} unpriced {totals.unpriced === 1 ? 'response' : 'responses'}</h3>
          <dl className={styles.definitionList}>
            {!!totals.missingRate && <div><dt>No matching public rate</dt><dd>{exactCount(totals.missingRate)}</dd></div>}
            {!!totals.missingUsage && <div><dt>Insufficient usage measurements</dt><dd>{exactCount(totals.missingUsage)}</dd></div>}
            {!!totals.incompletePricing && <div><dt>Missing rate for a measured usage type</dt><dd>{exactCount(totals.incompletePricing)}</dd></div>}
          </dl>
        </section>}
        <div className={styles.dialogFooter}>
          <PriceSources asOf={asOf} />
          <Dialog.Close asChild><button type="button" className={styles.actionButton}>Close</button></Dialog.Close>
        </div>
      </Dialog.Content>
    </Dialog.Portal>
  </Dialog.Root>;
}
