import React from 'react';
import ReactDOM from 'react-dom/client';
import { ConfigProvider, App as AntApp } from 'antd';
import zhCN from 'antd/locale/zh_CN';
import { applyHbCssVariables, themeConfig } from './theme.js';
import App from './App.jsx';
import './styles.css';
import './v2-foundation.css';
import './decision-ui.css';

applyHbCssVariables();

// Used until the topbar has been measured, and whenever it is not on screen.
// Matches the .topbar min-height in styles.css plus the same 8px gap.
const TOAST_TOP_FALLBACK = 66;
const TOAST_TOP_GAP = 8;

// Toasts default to the viewport top, where they covered the topbar's job
// selector across candidate / talent / jobs / guide. The offset has to be
// measured rather than hardcoded: below 900px the topbar re-flows into a
// two-column grid that wraps onto two rows, so a fixed desktop offset puts the
// toasts back on top of it. A media query cannot fix that either — antd applies
// `top` as an inline style on the message container (message/useMessage.js
// getStyle), which no stylesheet rule can override without !important.
function useToastTopOffset() {
  const [top, setTop] = React.useState(TOAST_TOP_FALLBACK);
  React.useEffect(() => {
    const measure = () => {
      const topbar = document.querySelector('.topbar');
      if (!topbar) {
        setTop(TOAST_TOP_FALLBACK);
        return;
      }
      // bottom is viewport-relative, which is what a fixed toast container
      // needs — but it shrinks if the bar has been scrolled away when the
      // measurement runs, so never go below the desktop offset.
      const { bottom } = topbar.getBoundingClientRect();
      // React bails out when the value is unchanged, so observing the whole
      // body costs a measurement, not a re-render.
      setTop(Math.max(TOAST_TOP_FALLBACK, Math.round(bottom) + TOAST_TOP_GAP));
    };
    measure();
    if (typeof ResizeObserver !== 'function') return undefined;
    const observer = new ResizeObserver(measure);
    observer.observe(document.body);
    return () => observer.disconnect();
  }, []);
  return top;
}

function HrbossRoot() {
  const toastTop = useToastTopOffset();
  return (
    <ConfigProvider theme={themeConfig} locale={zhCN} button={{ autoInsertSpace: false }}>
      {/* Deliberately no maxCount: capping the queue would silently drop
          errors, which is worse than a long stack now that it opens below the
          topbar with room to grow. */}
      <AntApp message={{ top: toastTop }}>
        <App />
      </AntApp>
    </ConfigProvider>
  );
}

ReactDOM.createRoot(document.getElementById('root')).render(
  <React.StrictMode>
    <HrbossRoot />
  </React.StrictMode>,
);
