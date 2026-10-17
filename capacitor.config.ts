import type { CapacitorConfig } from '@capacitor/cli';

const config: CapacitorConfig = {
  appId: 'uk.benext.speak',
  appName: '发音',
  webDir: 'dist',
  server: {
    // Capacitor 默认就是 https://localhost；写明后模型按同源 /models/ 加载
    androidScheme: 'https',
  },
};

export default config;
