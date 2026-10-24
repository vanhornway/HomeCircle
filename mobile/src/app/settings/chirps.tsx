import { ChirpSettings } from '../../components/ChirpSettings';
import { SettingsPage } from '../../components/SettingsKit';
import { useCircles } from '../../lib/circle';
import { useSettings } from '../../lib/storage';

/** Your chirp, how chirps reach this phone, and SOS. */
export default function ChirpSettingsPage() {
  const settings = useSettings();
  const { clients } = useCircles();
  return (
    <SettingsPage title="Chirps & SOS">
      <ChirpSettings clients={clients} settings={settings} onChange={() => {}} />
    </SettingsPage>
  );
}
