import React from 'react';
import { Alert, Button, Space } from 'antd';

const LazyRetryContext = React.createContext(null);

export function createRetryableLazy(loader) {
  const lazyByRetryToken = new WeakMap();
  const unscopedLazyComponent = React.lazy(loader);
  return function RetryableLazyComponent(props) {
    const retryToken = React.useContext(LazyRetryContext);
    let LazyComponent = unscopedLazyComponent;
    if (retryToken) {
      LazyComponent = lazyByRetryToken.get(retryToken);
      if (!LazyComponent) {
        LazyComponent = React.lazy(loader);
        lazyByRetryToken.set(retryToken, LazyComponent);
      }
    }
    return <LazyComponent {...props} />;
  };
}

export default class FeatureErrorBoundary extends React.Component {
  constructor(props) {
    super(props);
    this.state = { error: null, retryKey: 0, retryToken: null };
    this.errorHeadingRef = React.createRef();
  }

  static getDerivedStateFromError(error) {
    return { error };
  }

  componentDidCatch() {
    this.focusErrorHeading();
  }

  componentDidUpdate(previousProps, previousState) {
    if (previousProps.featureKey !== this.props.featureKey && this.state.error) {
      this.setState({ error: null, retryKey: 0, retryToken: {} });
      return;
    }
    if (previousProps.focusOnError === false && this.props.focusOnError !== false && this.state.error) {
      this.focusErrorHeading();
      return;
    }
    if (!previousState.error && this.state.error) this.focusErrorHeading();
  }

  focusErrorHeading() {
    if (this.props.focusOnError === false) return;
    const focusHeading = () => this.errorHeadingRef.current?.focus?.({ preventScroll: true });
    if (globalThis.requestAnimationFrame) globalThis.requestAnimationFrame(focusHeading);
    else globalThis.setTimeout(focusHeading, 0);
  }

  handleRetry = () => {
    this.setState((current) => ({ error: null, retryKey: current.retryKey + 1, retryToken: {} }));
  };

  render() {
    const {
      children,
      featureLabel = '当前模块',
      onExit,
      exitLabel = '返回工作台',
      modal = false,
    } = this.props;
    const { error, retryKey, retryToken } = this.state;

    if (!error) {
      return (
        <LazyRetryContext.Provider value={retryToken}>
          <React.Fragment key={retryKey}>{children}</React.Fragment>
        </LazyRetryContext.Provider>
      );
    }

    return (
      <section
        className={`feature-error-boundary${modal ? ' feature-error-boundary-modal' : ''}`}
        role="alert"
        style={modal ? {
          position: 'fixed',
          inset: 0,
          zIndex: 1100,
          display: 'grid',
          placeItems: 'center',
          padding: 24,
          background: 'rgba(255, 255, 255, 0.92)',
        } : { width: '100%', padding: 16 }}
      >
        <Alert
          type="error"
          showIcon
          message={(
            <h2 ref={this.errorHeadingRef} tabIndex={-1} style={{ margin: 0, fontSize: 16 }}>
              {featureLabel}暂时无法显示
            </h2>
          )}
          description="当前故障只影响这个模块；Shell、岗位上下文和其他模块仍可使用。重试不会自动提交任何招聘操作。"
          action={(
            <Space wrap>
              <Button onClick={this.handleRetry}>重试模块</Button>
              {onExit && <Button type="primary" onClick={onExit}>{exitLabel}</Button>}
            </Space>
          )}
        />
      </section>
    );
  }
}
