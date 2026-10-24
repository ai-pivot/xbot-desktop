import { Component, type ErrorInfo, type ReactNode } from "react";

interface Props {
  children: ReactNode;
}

interface State {
  error: Error | null;
}

/**
 * A render error used to unmount the whole React tree, which looks like a
 * black window with no way out. Catch it and offer a reload instead.
 */
export class ErrorBoundary extends Component<Props, State> {
  state: State = { error: null };

  static getDerivedStateFromError(error: Error): State {
    return { error };
  }

  componentDidCatch(error: Error, info: ErrorInfo) {
    console.error("xbot ui render error", error, info.componentStack);
  }

  render() {
    const { error } = this.state;
    if (!error) return this.props.children;
    return (
      <div className="crash">
        <div className="crash-title">界面渲染出错了</div>
        <pre className="crash-detail">{String(error.stack || error.message || error)}</pre>
        <div className="crash-actions">
          <button className="button secondary" onClick={() => this.setState({ error: null })}>
            重试
          </button>
          <button className="button primary" onClick={() => window.location.reload()}>
            重新加载
          </button>
        </div>
      </div>
    );
  }
}
