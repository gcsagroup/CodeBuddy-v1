import GitHubConnections from './GitHubConnections';

// Settings and Toolbox share the same account flow.
export default function RepositoryConnections() {
  return <GitHubConnections allowLogin />;
}
