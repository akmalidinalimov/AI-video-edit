import { Config } from "@remotion/cli/config";
import path from "path";

Config.setVideoImageFormat("jpeg");
Config.setOverwriteOutput(true);
Config.setPublicDir(path.join(process.cwd(), "public"));

Config.overrideWebpackConfig((currentConfig) => {
  return {
    ...currentConfig,
    resolve: {
      ...currentConfig.resolve,
      alias: {
        ...(currentConfig.resolve?.alias ?? {}),
        "@": path.join(process.cwd(), "src"),
      },
    },
  };
});
