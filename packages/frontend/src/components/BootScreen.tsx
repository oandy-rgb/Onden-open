import BootWatchdog from "./BootWatchdog";

/** Shown until the workspace has its data and chunks (BuilderWorkspace), and
 *  while its code downloads after sign-in (BuilderApp). */
export default function BootScreen() {
  return (
    <BootWatchdog>
      <main className="app-shell">
        <div className="app-boot-screen">
          <div className="app-boot-logo">Onden</div>
          <div className="app-boot-spinner" />
        </div>
      </main>
    </BootWatchdog>
  );
}
