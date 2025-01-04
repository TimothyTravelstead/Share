<?php
// First, install required packages via composer:
// composer require cboden/ratchet ramsey/uuid

require __DIR__ . '/vendor/autoload.php';

use Ratchet\Server\IoServer;
use Ratchet\Http\HttpServer;
use Ratchet\WebSocket\WsServer;
use Ratchet\MessageComponentInterface;
use Ratchet\ConnectionInterface;
use Ramsey\Uuid\Uuid;

class MediaServer implements MessageComponentInterface {
    private $rooms;  // Array to store rooms
    private $clientInfo; // Store client info (roomName, userId)

    public function __construct() {
        $this->rooms = [];  // Changed from SplObjectStorage to array
        $this->clientInfo = new \SplObjectStorage;
    }

    public function onOpen(ConnectionInterface $conn) {
        // Parse query string to get room name
        $queryString = $conn->httpRequest->getUri()->getQuery();
        parse_str($queryString, $params);
        
        if (!isset($params['room'])) {
            $conn->send(json_encode([
                'error' => 'Room name is required to connect'
            ]));
            $conn->close();
            return;
        }

        $roomName = $params['room'];
        $userId = Uuid::uuid4()->toString();

        // Store client info
        $this->clientInfo->attach($conn, [
            'roomName' => $roomName,
            'userId' => $userId
        ]);

        // Create room if it doesn't exist
        if (!isset($this->rooms[$roomName])) {
            $this->rooms[$roomName] = new \SplObjectStorage;
        }
        
        // Add client to room
        $this->rooms[$roomName]->attach($conn);

        // Send welcome message
        $conn->send(json_encode([
            'type' => 'welcome',
            'message' => "Welcome to room: $roomName",
            'userId' => $userId
        ]));

        // Broadcast updated user list
        $this->broadcastConnectedUsers($roomName);

        echo "New connection! ({$conn->resourceId}) in room: $roomName\n";
    }

    public function onMessage(ConnectionInterface $from, $msg) {
        $data = json_decode($msg, true);
        if (!$data) {
            echo "Error parsing message\n";
            return;
        }

        if (!$this->clientInfo->contains($from)) {
            echo "Client not found in clientInfo\n";
            return;
        }

        $clientInfo = $this->clientInfo[$from];
        $roomName = $clientInfo['roomName'];
        $fromUserId = $clientInfo['userId'];

        switch ($data['type']) {
            case 'offer':
            case 'answer':
            case 'ice-candidate':
                if (isset($this->rooms[$roomName])) {
                    foreach ($this->rooms[$roomName] as $client) {
                        if ($this->clientInfo->contains($client)) {
                            $targetInfo = $this->clientInfo[$client];
                            if ($targetInfo['userId'] === $data['target']) {
                                $data['from'] = $fromUserId;
                                $client->send(json_encode($data));
                                break;
                            }
                        }
                    }
                }
                break;
            
            default:
                echo "Unknown message type: {$data['type']}\n";
                break;
        }
    }

    public function onClose(ConnectionInterface $conn) {
        if (!$this->clientInfo->contains($conn)) {
            return;
        }

        // Get client info before removing
        $clientInfo = $this->clientInfo[$conn];
        $roomName = $clientInfo['roomName'];

        // Remove from room
        if (isset($this->rooms[$roomName])) {
            $this->rooms[$roomName]->detach($conn);

            // If room is empty, remove it
            if ($this->rooms[$roomName]->count() === 0) {
                unset($this->rooms[$roomName]);
                echo "Room $roomName deleted as it is empty.\n";
            } else {
                $this->broadcastConnectedUsers($roomName);
            }
        }

        // Remove client info
        $this->clientInfo->detach($conn);

        echo "Connection {$conn->resourceId} has disconnected\n";
    }

    public function onError(ConnectionInterface $conn, \Exception $e) {
        echo "An error has occurred: {$e->getMessage()}\n";
        
        if ($this->clientInfo->contains($conn)) {
            $clientInfo = $this->clientInfo[$conn];
            $roomName = $clientInfo['roomName'];
            
            if (isset($this->rooms[$roomName])) {
                $this->rooms[$roomName]->detach($conn);
                
                if ($this->rooms[$roomName]->count() === 0) {
                    unset($this->rooms[$roomName]);
                }
            }
            
            $this->clientInfo->detach($conn);
        }
        
        $conn->close();
    }

    private function broadcastConnectedUsers($roomName) {
        if (!isset($this->rooms[$roomName])) {
            return;
        }

        $userIds = [];
        foreach ($this->rooms[$roomName] as $client) {
            if ($this->clientInfo->contains($client)) {
                $userIds[] = $this->clientInfo[$client]['userId'];
            }
        }

        $message = json_encode([
            'type' => 'users',
            'users' => $userIds
        ]);

        foreach ($this->rooms[$roomName] as $client) {
            try {
                $client->send($message);
            } catch (\Exception $e) {
                echo "Failed to send message to client: {$e->getMessage()}\n";
            }
        }
    }
}

// Create server.php file to run the WebSocket server
$server = IoServer::factory(
    new HttpServer(
        new WsServer(
            new MediaServer()
        )
    ),
    8080
);

echo "WebSocket server running on ws://localhost:8080\n";
$server->run();
?>
