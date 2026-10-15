import { DictationSettings } from '../dictation/DictationSettings';
import { SpellcheckToggle } from '../chat/SpellcheckToggle';
import { Card, CardContent } from '../../ui/card';

export default function InputSettingsSection() {
  return (
    <div className="space-y-4 pr-4 pb-8 mt-1">
      <Card className="rounded-lg pb-2">
        <CardContent className="px-2">
          <DictationSettings />
          <SpellcheckToggle />
        </CardContent>
      </Card>
    </div>
  );
}
