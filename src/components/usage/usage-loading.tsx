import styles from './usage-dashboard.module.css';

function Placeholder({ width, size = 'label' }: { width: string; size?: 'caption' | 'label' | 'number' | 'total' }) {
  return <span className={styles.skeletonBar} data-size={size} style={{ width }} />;
}

const rowWidths = ['60%', '46%', '68%', '54%'];
const metricWidths = ['56%', '42%', '61%', '33%', '48%', '67%'];

export function UsageLoadingContent() {
  return <>
    <span role="status" className={styles.srOnly}>Loading usage records…</span>
    <div className={styles.skeleton} aria-hidden="true">
      <div className={styles.overview}>
        <div className={styles.valuePanel}>
          <div className={styles.valueHeading}><Placeholder width="82px" /><Placeholder width="22px" size="caption" /></div>
          <div className={styles.skeletonAmount}><Placeholder width="72%" size="total" /></div>
          <Placeholder width="76%" size="caption" />
          <div className={styles.seriesList}>
            {rowWidths.map(width => <div className={styles.skeletonSeriesRow} key={width}>
              <div className={styles.skeletonSeriesName}><Placeholder width={width} /><Placeholder width="44px" /></div>
              <Placeholder width="69%" size="caption" />
            </div>)}
          </div>
        </div>
        <div className={styles.chartPanel}>
          <div className={styles.sectionHead}><Placeholder width="126px" /><Placeholder width="87px" /></div>
          <div className={styles.plot}>
            <div className={styles.skeletonPlot}>
              <div className={styles.skeletonAxis}>
                {[0, 1, 2, 3, 4].map(tick => <Placeholder key={tick} width="29px" size="caption" />)}
              </div>
              <div className={styles.skeletonGrid}>
                <div className={styles.skeletonTicks}>
                  {[0, 1, 2].map(tick => <Placeholder key={tick} width="34px" size="caption" />)}
                </div>
              </div>
            </div>
          </div>
          <div className={styles.chartFooter}><div className={styles.legend}>
            <Placeholder width="46px" size="caption" /><Placeholder width="66px" size="caption" /><Placeholder width="51px" size="caption" />
          </div></div>
        </div>
      </div>
      <div className={styles.stats}>{metricWidths.map(width => <div className={styles.skeletonMetric} key={width}>
        <Placeholder width="66%" size="caption" />
        <Placeholder width={width} size="number" />
        <Placeholder width="82%" size="caption" />
      </div>)}</div>
      <div className={styles.mix}>
        {['36%', '44%'].map(width => <div className={styles.mixPanel} key={width}>
          <Placeholder width="105px" />
          <div className={styles.mixTrack}><Placeholder width="100%" size="caption" /></div>
          <div className={styles.skeletonMixLabels}>
            <Placeholder width={width} size="caption" /><Placeholder width="26%" size="caption" />
          </div>
        </div>)}
      </div>
      <div className={styles.details}>
        <div className={styles.breakdown}>
          <div className={styles.sectionHead}><Placeholder width="116px" /><Placeholder width="118px" /></div>
          <div className={styles.skeletonRows}>{rowWidths.map(width => <div className={styles.skeletonRow} key={width}>
            <Placeholder width={width} />
            <Placeholder width="65%" size="caption" />
            <Placeholder width="52%" size="caption" />
            <Placeholder width="61%" size="caption" />
          </div>)}</div>
        </div>
        <div className={styles.coverage}>
          <div className={styles.sectionHead}><Placeholder width="101px" /><Placeholder width="15px" /></div>
          <div className={styles.skeletonCoverage}><Placeholder width="76px" size="number" /><Placeholder width="70%" size="caption" /></div>
          <div className={styles.coverageBar} />
          {rowWidths.slice(0, 3).map(width => <div className={styles.skeletonCoverageRow} key={width}>
            <Placeholder width={width} size="caption" /><Placeholder width="24px" size="caption" />
          </div>)}
        </div>
      </div>
    </div>
  </>;
}

export function UsageLoadingFallback() {
  return <section className={styles.dashboard} aria-labelledby="usage-heading" id="eterx-usage-dashboard">
    <div className={styles.scrollPane}>
      <div className={styles.content}>
        <header className={styles.header}>
          <div className={styles.headerTop}>
            <div className={styles.headingGroup}>
              <div className={styles.titleLine}><h1 id="usage-heading">Usage</h1></div>
              <div aria-hidden="true" className={styles.skeletonDate}><Placeholder width="145px" size="caption" /></div>
            </div>
            <div aria-hidden="true" className={styles.skeletonControl}><Placeholder width="156px" /></div>
          </div>
          <div className={styles.toolbar} aria-hidden="true">
            <div className={styles.controls}>
              <div className={styles.skeletonControl}><Placeholder width="94px" /></div>
              <div className={styles.skeletonControl}><Placeholder width="102px" /></div>
            </div>
            <div className={styles.controls}>
              <div className={styles.skeletonControl}><Placeholder width="220px" /></div>
              <div className={styles.skeletonControl}><Placeholder width="16px" /></div>
              <div className={styles.skeletonControl}><Placeholder width="89px" /></div>
            </div>
          </div>
        </header>
        <UsageLoadingContent />
      </div>
    </div>
  </section>;
}
