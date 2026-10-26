import { Github } from 'lucide-react';
import { useIntl } from '../../../i18n';
import { Card, CardContent, CardDescription, CardHeader, CardTitle } from '../../ui/card';
import RepositoryConnections from './RepositoryConnections';
import { selectNativeText } from '../../../utils/nativeLocalization';

export default function GitHubAuthCard() {
  const intl = useIntl();
  return (
    <Card className="pb-2">
      <CardHeader className="pb-0">
        <CardTitle className="flex items-center gap-2">
          <Github className="h-4 w-4" />
          {selectNativeText(intl.locale, 'Code repositories', '代码仓库', '程式碼儲存庫')}
        </CardTitle>
        <CardDescription>
          {selectNativeText(
            intl.locale,
            'Local Git is built in. Sign in to manage GitHub repositories.',
            '已内置本地 Git，登录后可管理 GitHub 仓库。',
            '已內建本機 Git，登入後可管理 GitHub 儲存庫。'
          )}
        </CardDescription>
      </CardHeader>
      <CardContent className="px-4 py-2">
        <RepositoryConnections />
      </CardContent>
    </Card>
  );
}
