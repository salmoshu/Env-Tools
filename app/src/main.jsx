import React from "react";
import { createRoot } from "react-dom/client";
import App from "./App.jsx";
import { t } from "./i18n.js";
import "./styles.css";

// 顶层错误边界：渲染期异常不再白屏，给出可恢复的提示（保留窗口可操作性）
class ErrorBoundary extends React.Component {
  constructor(props) {
    super(props);
    this.state = { error: null };
  }

  static getDerivedStateFromError(error) {
    return { error };
  }

  componentDidCatch(error) {
    console.error("[app] render error:", error);
  }

  render() {
    if (this.state.error) {
      return (
        <div className="error-boundary">
          <div className="error-boundary-title">{t("state.errorTitle")}</div>
          <div className="error-boundary-msg">
            {String(this.state.error.message || this.state.error)}
          </div>
          <button
            type="button"
            className="error-boundary-btn"
            onClick={() => this.setState({ error: null })}
          >
            {t("state.retry")}
          </button>
        </div>
      );
    }
    return this.props.children;
  }
}

createRoot(document.getElementById("root")).render(
  <ErrorBoundary>
    <App />
  </ErrorBoundary>
);
