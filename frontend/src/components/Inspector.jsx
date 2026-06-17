// Lightweight stand-in for react-inspector, which was dropped because it has no
// React 19 peer support. Used only in debug UI (ViewCurrentState, AlertMessages)
// to dump an object; a pretty-printed <pre> is plenty.
export const Inspector = ({data}) => (
    <pre style={{fontSize: '0.8em', overflow: 'auto', maxHeight: 300, margin: 0}}>
      {(() => {
        try {
          return JSON.stringify(data, (k, v) => (typeof v === 'bigint' ? v.toString() : v), 2);
        } catch {
          return String(data);
        }
      })()}
    </pre>);
