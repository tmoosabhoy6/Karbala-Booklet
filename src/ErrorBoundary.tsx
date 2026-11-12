// Anything that throws while drawing the app shows what went wrong and a way
// back, instead of a blank page. The booklet itself is safe: every change is
// kept in this browser and on the server as it is made.
import { Component, type ReactNode } from 'react';

export class ErrorBoundary extends Component<{ children: ReactNode }, { error: Error | null }> {
  state = { error: null as Error | null };
  static getDerivedStateFromError(error: Error) {
    return { error };
  }
  componentDidCatch(error: Error) {
    console.error(error);
  }
  render() {
    if (!this.state.error) return this.props.children;
    return (
      <div className="loading" role="alert">
        <p>Something went wrong while showing the booklet: {this.state.error.message}</p>
        <p>Your work is saved. Reload the page to carry on.</p>
        <button onClick={() => location.reload()}>Reload</button>
      </div>
    );
  }
}
