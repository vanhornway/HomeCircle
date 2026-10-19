// Entry point. Background tasks must be defined at module scope before the
// app renders, so they are imported here ahead of the router.
import 'react-native-get-random-values';
import './src/background/tasks';
import 'expo-router/entry';
