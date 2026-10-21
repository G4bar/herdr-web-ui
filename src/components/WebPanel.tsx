import { useState, type ReactNode } from "react";
import { ExternalLink, Globe, RotateCw, X } from "lucide-react";
import { useT } from "../lib/i18n.ts";
import { panelFrameSrc } from "../lib/webPanel.ts";
import "./FileViewer.css";

export interface WebPanelProps {
  url: string;
  /** pushes of this page: each one loads it again, also while it is already shown */
  refresh?: number;
  onClose: () => void;
  panelStart?: ReactNode;
}

/**
 * A page served by this PC beside the pane, in the file panel's place and chrome. The frame is a
 * cross-origin page (another port), so its scripts and storage are its own; the sandbox still
 * keeps it from navigating this window.
 */
export function WebPanel({ url, refresh = 0, onClose, panelStart }: WebPanelProps) {
  const t = useT();
  const [loads, setLoads] = useState(0);
  // both counters only grow, so a reload and a push each name an address the frame has not had
  const frame = panelFrameSrc(url, loads + refresh);
  const { host, pathname, search } = new URL(url);
  const label = `${host}${pathname === "/" ? "" : pathname}${search}`;
  return (
    <aside className="file-panel web-panel" aria-label={label}>
      {panelStart}
      <section className="file-viewer file-viewer-docked">
        <header className="file-viewer-header file-viewer-header-docked">
          <Globe aria-hidden="true" className="file-viewer-glyph" />
          <h2 className="file-viewer-name" title={url}><span className="file-viewer-stem">{label}</span></h2>
          <div className="file-viewer-actions">
            <button type="button" className="icon-button file-viewer-action" aria-label={t("Reload page")} title={t("Reload page")} onClick={() => setLoads((count) => count + 1)}><RotateCw aria-hidden="true" /></button>
            <a className="icon-button file-viewer-action" href={url} target="_blank" rel="noopener noreferrer" aria-label={t("Open in a new tab")} title={t("Open in a new tab")}><ExternalLink aria-hidden="true" /></a>
          </div>
          <button type="button" className="icon-button file-viewer-action file-viewer-close" aria-label={t("Close page")} title={t("Close page")} onClick={onClose}><X aria-hidden="true" /></button>
        </header>
        <div className="file-viewer-body">
          <iframe key={frame} className="file-viewer-page" src={frame} title={label}
            sandbox="allow-scripts allow-same-origin allow-forms allow-modals allow-popups allow-popups-to-escape-sandbox allow-downloads" />
        </div>
      </section>
    </aside>
  );
}
