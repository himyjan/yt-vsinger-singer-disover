# Historical platform analytics

The **Analytics** view charts channel metrics, ranks performers by the latest
available sample, compares the first and latest sample in the selected period,
and lists top content by its latest recorded view count. The global scope,
region and platform filters apply to the view; the metric and history range
are selected in the analytics panel.

Analytics is optional for the original site and is detected automatically.
The app checks the public archive index once at startup and shows the view only
when the index contains at least one date. When the archive is missing,
unavailable or empty, the Analytics tab stays hidden; scheduled history
collection can run independently.

## Collection

The six-hour sync selects channel profiles incrementally, bounded by the
configured per-run details budget. It writes the collected observations to
`.cache/analytics-pending.json` only after the main dataset has been written.
The workflow appends those observations to the public
[`yt-vsinger-singer-disover-analytics`](https://github.com/himyjan/yt-vsinger-singer-disover-analytics)
repository. The main repository stores no daily history, preserving its
180 MB `data/` limit.

Add `ANALYTICS_REPO_TOKEN` under **Settings → Secrets and variables → Actions**
in the tracker repository. The token needs Contents read/write access to the
analytics archive. If it is missing, the dataset sync still succeeds, but the
workflow emits a warning and does not archive analytics.

The archive consists of:

- `data/index.json`: schema version and sorted list of dates with data.
- `data/daily/YYYY-MM-DD.json`: channel/platform observations and recent
  content view counts for that date.

The app reads the index and selected date shards directly from
`raw.githubusercontent.com`. The endpoint supports browser CORS. Date shards
that are temporarily unavailable are skipped; an unavailable index is shown
as an explicit archive error in the view.

## Metrics and limitations

Available metrics are followers/subscribers, lifetime channel views, published
video count, average recent-content views and concurrent live viewers. A
missing value means the platform did not publish it or its adapter could not
retrieve it; it is never interpreted as zero. The coverage note in the view
explains known platform limitations. API credentials are required for some
sources, including VK and CI.ME. Live viewers are point-in-time samples, not
historical stream peaks.

Samples are deduplicated per channel and platform per UTC day. The displayed
change is the difference between the first and most recent available sample
within the chosen range, not a forecast or a normalized growth rate. A row
needs at least two samples to show a change.
