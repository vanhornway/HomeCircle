// Which app this build is: HomeCircle, or the Elderly Companion app (built
// from the same project with APP_VARIANT=companion; see app.config.js).
import Constants from 'expo-constants';

export const IS_COMPANION = Constants.expoConfig?.extra?.variant === 'companion';
