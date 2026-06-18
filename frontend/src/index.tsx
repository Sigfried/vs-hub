import React from "react";
import ReactDOM from "react-dom/client";
import { BrowserRouter } from "react-router-dom";
import { AppWrapper, RoutesContainer /* HookTestApp */ } from "./App";


// Match the Vite base path so routing works under the GitHub Pages subpath
// (sigfried.github.io/vs-hub/). BASE_URL is "/vs-hub/" in the Pages build, "/"
// in dev; React Router wants the basename without a trailing slash.
const basename = import.meta.env.BASE_URL.replace(/\/$/, "");

const root = ReactDOM.createRoot(document.getElementById("root"));
root.render(
  <BrowserRouter basename={basename}>
    {/*<HookTestApp />*/}
    <AppWrapper>
        <RoutesContainer />
    </AppWrapper>
  </BrowserRouter>
);

// If you want to start measuring performance in your app, pass a function
// to log results (for example: reportWebVitals(console.log))
// or send to an analytics endpoint. Learn more: https://bit.ly/CRA-vitals
// reportWebVitals();

/*
https://reactjs.org/docs/error-boundaries.html
<ErrorBoundary>
</ErrorBoundary>
class ErrorBoundary extends React.Component {
  constructor(props) {
    super(props);
    this.state = { hasError: false };
  }

  static getDerivedStateFromError(error) {
    // Update state so the next render will show the fallback UI.
    return { hasError: true };
  }


  componentDidCatch(error, errorInfo) {
    // You can also log the error to an error reporting service
    // logErrorToMyService(error, errorInfo);
    console.log(error, errorInfo);
  }

  render() {
    if (this.state.hasError) {
      // You can render any custom fallback UI
      return <h1>Something went wrong.</h1>;
    }

    return this.props.children;
  }
}
*/
