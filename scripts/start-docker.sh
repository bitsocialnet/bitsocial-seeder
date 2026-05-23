root_path=$(cd `dirname $0` && cd .. && pwd)
cd "$root_path"

docker rm -f bitsocial-seeder 2>/dev/null

docker run \
  --detach \
  --network=host \
  --volume=$(pwd):/usr/src/ipfs \
  --workdir=/usr/src/ipfs \
  --name bitsocial-seeder \
  --restart always \
  --log-opt max-size=10m \
  --log-opt max-file=5 \
  node:24 sh -c "npm ci; node start.js"

docker logs --follow bitsocial-seeder
