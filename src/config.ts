import * as fs from 'fs';
import * as yaml from 'js-yaml';

export class LinkedInConfigWrap {
  public cookies: CookieConfig = new CookieConfig();

  public static async fromConfig(file: string): Promise<LinkedInConfigWrap> {
    const output = new LinkedInConfigWrap();
    const data: string = await new Promise((resolve, reject) =>
      fs.readFile(
        file,
        { encoding: 'utf-8' },
        (error: NodeJS.ErrnoException | null, data: string) => {
          if (error) {
            reject(error);
          } else {
            resolve(data);
          }
        },
      ),
    );
    output.applyConfig(yaml.safeLoad(data) as Record<string, unknown>);
    return output;
  }

  private applyConfig(
    /* eslint-disable */
    newConfig: { [key: string]: any },
    configLayer: { [key: string]: any } = this,
    /* eslint-enable */
  ) {
    Object.keys(newConfig).forEach((key) => {
      if (
        configLayer[key] instanceof Object &&
        !(configLayer[key] instanceof Array)
      ) {
        this.applyConfig(newConfig[key], configLayer[key]);
      } else {
        configLayer[key] = newConfig[key];
      }
    });
  }
}

class CookieConfig {
  public directory = '/data';
}
