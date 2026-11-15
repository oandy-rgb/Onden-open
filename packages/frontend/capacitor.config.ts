import type { CapacitorConfig } from "@capacitor/cli";

const config: CapacitorConfig = {
  appId: "com.onden.app",
  appName: "Onden",
  webDir: "dist-cap",
  server: {
    androidScheme: "http",
  },
};

export default config;
